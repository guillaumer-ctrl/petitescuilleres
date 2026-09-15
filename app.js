const state = {
  planningId: null,
  role: null, // 'edit' | 'view'
  tab: 'planning',
  showModal: false,
  showCreate: false,
  statsExpanded: null,
  editingField: null,
  statsExpandedCategory: null,
  knownPlannings: [],
  showBabySwitcher: false,
  loading: true,
  user: null,
  authLoading: true,
  authScreen: 'landing', // 'landing' | 'login' | 'signup'
  authMethod: 'email', // 'email' | 'phone'
  needsPseudo: false,
  editingPseudo: false,
  userProfile: null,
  inviteRole: null, // 'edit' | 'view' | null — rôle sélectionné pour donner un accès, aucun par défaut
  grantError: null,
  grantSuccessMessage: null,
  grantBusy: false,
  authError: null,
  authBusy: false
};

function localDateStr(d){
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Echappe le HTML dans les donnees affichees qui viennent d'un autre membre
// du planning (prenom, aliments, pseudo, photo...) : ces valeurs transitent
// par Firestore et sont partagees entre plusieurs comptes, donc injectees
// telles quelles dans innerHTML elles permettraient a n'importe quel membre
// en ecriture d'executer du code dans le navigateur des autres membres.
function escapeHtml(str){
  if(str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Remplace alert()/confirm() natifs par une modale coherente avec le design
// de l'app, accessible (role dialog, fermeture a la touche Echap, focus pose
// dessus a l'ouverture) et qui ne bloque pas le thread comme le ferait un
// confirm() natif.
function showFeedbackModal(message, { confirmLabel = 'OK', cancelLabel = null } = {}){
  return new Promise(resolve => {
    let root = document.getElementById('feedback-root');
    if(!root){
      root = document.createElement('div');
      root.id = 'feedback-root';
      document.body.appendChild(root);
    }
    root.innerHTML = `
      <div class="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="feedback-message">
        <div class="modal-sheet">
          <p id="feedback-message" style="font-size:16px;color:var(--text);margin:0 0 1.25rem;">${escapeHtml(message)}</p>
          <div style="display:flex;gap:10px;">
            ${cancelLabel ? `<button class="btn btn-secondary" id="feedback-cancel-btn" style="margin:0;">${escapeHtml(cancelLabel)}</button>` : ''}
            <button class="btn btn-primary" id="feedback-confirm-btn" style="margin:0;color:#FFFFFF;">${escapeHtml(confirmLabel)}</button>
          </div>
        </div>
      </div>
    `;
    const cleanup = (result) => {
      document.removeEventListener('keydown', onKey);
      root.innerHTML = '';
      resolve(result);
    };
    const onKey = (e) => { if(e.key === 'Escape') cleanup(false); };
    document.addEventListener('keydown', onKey);
    const cancelBtn = document.getElementById('feedback-cancel-btn');
    if(cancelBtn) cancelBtn.onclick = () => cleanup(false);
    const confirmBtn = document.getElementById('feedback-confirm-btn');
    confirmBtn.onclick = () => cleanup(true);
    confirmBtn.focus();
  });
}
function showAlert(message){ return showFeedbackModal(message); }
function showConfirm(message){ return showFeedbackModal(message, { confirmLabel: 'Confirmer', cancelLabel: 'Annuler' }); }

function normalizeAlimentName(text){
  return (text || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .trim();
}

function applyReactionToMatchingMeals(sourceFood, reaction){
  const source = normalizeAlimentName(sourceFood);
  if(!source) return [];
  const touchedIds = [];
  planningData.meals.forEach(m => {
    if(m.statut !== 'passe') return;
    if(!m.reactions) m.reactions = getMealReactions(m);
    let touched = false;
    getMealFoods(m).forEach(food => {
      if(normalizeAlimentName(food) === source){
        m.reactions[food] = reaction;
        touched = true;
      }
    });
    if(touched) touchedIds.push(m.id);
  });
  return touchedIds;
}

const FOOD_LIST = {
  'Légumes': ['Carotte','Courgette','Patate douce','Brocoli','Petit pois','Épinard','Potiron','Haricot vert','Poireau','Navet','Chou-fleur','Betterave','Panais','Aubergine','Tomate','Concombre','Céleri','Fenouil','Artichaut','Champignon','Poivron','Radis','Endive','Chou','Chou de Bruxelles','Blette','Topinambour'],
  'Fruits': ['Pomme','Poire','Banane','Pêche','Abricot','Fraise','Mangue','Prune','Raisin','Melon','Pastèque','Kiwi','Ananas','Framboise','Myrtille','Cerise','Nectarine','Clémentine','Orange','Pamplemousse','Figue','Papaye','Rhubarbe','Coing','Mirabelle','Cassis'],
  'Féculents': ['Riz','Pâtes','Pomme de terre','Semoule','Pain','Quinoa','Boulgour','Polenta','Avoine','Millet','Sarrasin','Lentilles','Pois chiches','Haricots blancs','Vermicelle','Orge'],
  'Viandes': ['Poulet','Bœuf','Dinde','Veau','Agneau','Porc','Lapin','Canard','Jambon blanc'],
  'Poissons': ['Cabillaud','Saumon','Colin','Sole','Lieu','Merlan','Truite','Dorade','Sardine'],
  'Herbes': ['Persil','Basilic','Ciboulette','Thym','Laurier','Coriandre','Aneth','Romarin','Menthe','Origan'],
  'Épices': ['Cannelle','Cumin','Curcuma','Vanille','Muscade','Gingembre','Paprika','Cardamome']
};

function getCategoryForAliment(name){
  if(planningData.customCategories && planningData.customCategories[name]) return planningData.customCategories[name];
  for(const cat in FOOD_LIST){
    if(FOOD_LIST[cat].includes(name)) return cat;
  }
  return 'Autres';
}

const FOOD_INDEX = Object.keys(FOOD_LIST).flatMap(cat => FOOD_LIST[cat].map(name => ({ name, cat })));

function randomCode(len){
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  for(let i=0;i<len;i++) s += chars[Math.floor(Math.random()*chars.length)];
  return s;
}

// Redimensionne/compresse une photo côté navigateur avant de la stocker :
// une photo brute prise avec un téléphone peut peser plusieurs Mo, alors que
// Firestore refuse les documents de plus de 1 Mo. On la ramène à une taille
// raisonnable pour un avatar (max 500px de côté, JPEG qualité 0.8).
function resizeImageFile(file, maxDim, quality){
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if(width > height){
          if(width > maxDim){ height = Math.round(height * maxDim / width); width = maxDim; }
        } else {
          if(height > maxDim){ width = Math.round(width * maxDim / height); height = maxDim; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ============================================================
// BASE DE DONNÉES (Firebase Firestore)
// Remplace ces 6 valeurs par celles de TON projet Firebase
// (Console Firebase > Paramètres du projet > Tes applications > Config SDK)
// ============================================================
const firebaseConfig = {
  apiKey: "AIzaSyCoVQGSTiN7_Go3VA_8pu5SsbuN0d4ZvYI",
  authDomain: "petitescuilleres-f2129.firebaseapp.com",
  projectId: "petitescuilleres-f2129",
  storageBucket: "petitescuilleres-f2129.firebasestorage.app",
  messagingSenderId: "494180150467",
  appId: "1:494180150467:web:64722263700733d216c676"
};
firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
const auth = firebase.auth();
const COLLECTION = 'petites-cuilleres';

const storageAPI = {
  async get(key, shared){
    if(!shared){
      const v = localStorage.getItem(key);
      if(v === null) throw new Error('not found');
      return { key, value: v, shared };
    }
    const doc = await db.collection(COLLECTION).doc(key).get();
    if(!doc.exists) throw new Error('not found');
    return { key, value: doc.data().value, shared };
  },
  async set(key, value, shared){
    if(!shared){
      localStorage.setItem(key, value);
      return { key, value, shared };
    }
    await db.collection(COLLECTION).doc(key).set({ value });
    return { key, value, shared };
  },
  async delete(key, shared){
    if(!shared){
      localStorage.removeItem(key);
      return { key, deleted: true, shared };
    }
    await db.collection(COLLECTION).doc(key).delete();
    return { key, deleted: true, shared };
  }
};

async function loadLocal(){
  try{
    const r = await storageAPI.get('my-planning', false);
    if(r && r.value){
      const parsed = JSON.parse(r.value);
      state.planningId = parsed.planningId;
      state.role = parsed.role;
      if(parsed.tab) state.tab = parsed.tab;
    }
  }catch(e){}
  await refreshKnownPlanningsFromMemberships();
  // Le planning "actif" est mémorisé sur l'appareil, pas par compte : si ce
  // compte n'a en réalité aucun accès dessus (ex: nouveau compte sur un
  // appareil qui a servi à un autre compte avant), on l'ignore.
  if(state.planningId && !state.knownPlannings.some(p => p.planningId === state.planningId)){
    state.planningId = null;
    state.role = null;
    try{ await storageAPI.delete('my-planning', false); }catch(e){}
  }
  state.loading = false;
  await subscribeToPlanning(state.planningId);
  render();
}

async function saveLocal(){
  await storageAPI.set('my-planning', JSON.stringify({planningId: state.planningId, role: state.role, tab: state.tab}), false);
  if(state.planningId){
    const idx = state.knownPlannings.findIndex(p => p.planningId === state.planningId);
    const entry = { planningId: state.planningId, role: state.role, babyName: planningData.babyName || '', photo: planningData.photo || '' };
    if(idx >= 0) state.knownPlannings[idx] = entry;
    else state.knownPlannings.push(entry);
    await storageAPI.set('my-plannings', JSON.stringify(state.knownPlannings), false);
  }
}

async function switchPlanning(planningId, role){
  state.planningId = planningId;
  state.role = role;
  state.tab = 'planning';
  await subscribeToPlanning(planningId);
  await saveLocal();
  render();
}

async function isOnlyAdmin(planningId, uid){
  try{
    const snap = await db.collection('planningMembers').doc(planningId).collection('members').get();
    return !snap.docs.some(d => d.id !== uid && d.data().role === 'edit');
  }catch(e){ console.error('Erreur vérification administrateurs', e); return false; }
}

async function forgetPlanning(planningId){
  const entry = state.knownPlannings.find(p => p.planningId === planningId);
  if(entry && entry.role === 'edit' && auth.currentUser){
    const alone = await isOnlyAdmin(planningId, auth.currentUser.uid);
    if(alone){
      await showAlert("Tu es le seul administrateur de ce planning. Donne d'abord l'accès Administrateur à quelqu'un d'autre (dans Paramètres) avant de pouvoir le quitter — sinon plus personne ne pourrait jamais y accéder.");
      return;
    }
  }
  if(auth.currentUser){
    await revokeAccess(planningId, auth.currentUser.uid);
  }
  state.knownPlannings = state.knownPlannings.filter(p => p.planningId !== planningId);
  await storageAPI.set('my-plannings', JSON.stringify(state.knownPlannings), false);
  if(state.planningId === planningId){
    unsubscribePlanning();
    state.planningId = null;
    state.role = null;
    try{ await storageAPI.delete('my-planning', false); }catch(e){}
  }
  render();
}

let planningData = { babyName: '', meals: [] };

// ============================================================
// SYNCHRONISATION TEMPS REEL D'UN PLANNING
// Un planning est reparti sur deux emplacements Firestore : le document
// "profil" (prenom, date de naissance, sexe, photo) et une sous-collection
// "meals" (un document par repas). Les deux sont ecoutes en temps reel via
// onSnapshot : quand un autre membre de la famille modifie quelque chose,
// tout le monde le voit apparaitre sans avoir a recharger l'app. Ecrire un
// champ ou un repas a la fois (plutot qu'un gros document unique reecrit en
// entier a chaque fois, comme avant) evite aussi qu'une modification d'une
// personne efface silencieusement celle d'une autre faite au meme moment.
//
// Les plannings crees avant ce changement stockaient encore tous leurs repas
// dans un tableau "meals" a l'interieur du document profil : au premier
// chargement par un administrateur, ce tableau est copie dans la
// sous-collection "meals" puis supprime du document profil (une seule
// operation atomique, donc jamais d'etat intermediaire incoherent). Un
// lecteur seul qui ouvrirait un planning pas encore migre n'a pas les droits
// d'ecriture necessaires : il continue simplement a lire l'ancien tableau en
// attendant qu'un administrateur ouvre l'app.
let unsubscribeProfile = null;
let unsubscribeMeals = null;
let profileSnapshotData = null;
let mealsSnapshotDocs = null;
const migratedPlanningIds = new Set();

function unsubscribePlanning(){
  if(unsubscribeProfile){ unsubscribeProfile(); unsubscribeProfile = null; }
  if(unsubscribeMeals){ unsubscribeMeals(); unsubscribeMeals = null; }
  profileSnapshotData = null;
  mealsSnapshotDocs = null;
}

async function migrateLegacyMealsIfNeeded(planningId, legacyMeals){
  if(migratedPlanningIds.has(planningId)) return;
  migratedPlanningIds.add(planningId);
  try{
    const batch = db.batch();
    const mealsRef = db.collection('plannings').doc(planningId).collection('meals');
    legacyMeals.forEach(m => {
      const { id, ...fields } = m;
      batch.set(mealsRef.doc(id || randomCode(8)), fields);
    });
    batch.update(db.collection(COLLECTION).doc('data:' + planningId), {
      meals: firebase.firestore.FieldValue.delete()
    });
    await batch.commit();
  }catch(e){
    console.error('Erreur migration des repas', e);
    migratedPlanningIds.delete(planningId); // on retentera au prochain chargement
  }
}

function applyPlanningSnapshots(){
  if(!profileSnapshotData) return;
  const legacyMeals = profileSnapshotData.meals;
  // Tant que la sous-collection est vide (pas encore lue, ou planning pas
  // encore migre), on affiche l'ancien tableau s'il en existe un, plutot que
  // de montrer un planning vide le temps que la migration se termine.
  const meals = (mealsSnapshotDocs && mealsSnapshotDocs.length > 0)
    ? mealsSnapshotDocs.map(d => ({ id: d.id, ...d.data() }))
    : (legacyMeals && legacyMeals.length ? legacyMeals : []);
  planningData = { ...profileSnapshotData, meals };
  if(legacyMeals && legacyMeals.length && mealsSnapshotDocs && mealsSnapshotDocs.length === 0 && state.role === 'edit'){
    migrateLegacyMealsIfNeeded(state.planningId, legacyMeals);
  }
}

function subscribeToPlanning(planningId){
  unsubscribePlanning();
  if(!planningId) return Promise.resolve();
  return new Promise(resolve => {
    let profileReady = false, mealsReady = false, resolved = false;
    const maybeResolve = () => {
      if(resolved || !profileReady || !mealsReady) return;
      resolved = true;
      resolve();
    };
    unsubscribeProfile = db.collection(COLLECTION).doc('data:' + planningId).onSnapshot(doc => {
      profileSnapshotData = doc.exists ? doc.data() : { babyName: '' };
      profileReady = true;
      applyPlanningSnapshots();
      maybeResolve();
      if(resolved) render();
    }, e => { console.error('Erreur synchro planning', e); profileReady = true; maybeResolve(); });
    unsubscribeMeals = db.collection('plannings').doc(planningId).collection('meals').onSnapshot(snap => {
      mealsSnapshotDocs = snap.docs;
      mealsReady = true;
      applyPlanningSnapshots();
      maybeResolve();
      if(resolved) render();
    }, e => { console.error('Erreur synchro repas', e); mealsReady = true; maybeResolve(); });
  });
}

async function savePlanningProfile(fields){
  try{
    await db.collection(COLLECTION).doc('data:' + state.planningId).set(fields, { merge: true });
    await saveLocal();
    return true;
  }catch(e){
    console.error('Erreur sauvegarde profil', e);
    await showAlert("Cette modification n'a pas pu être enregistrée (droits insuffisants ou connexion coupée).");
    return false;
  }
}

async function saveMeal(meal){
  try{
    const { id, ...fields } = meal;
    await db.collection('plannings').doc(state.planningId).collection('meals').doc(id).set(fields);
    return true;
  }catch(e){
    console.error('Erreur sauvegarde repas', e);
    await showAlert("Ce repas n'a pas pu être enregistré (droits insuffisants ou connexion coupée).");
    return false;
  }
}

async function deleteMeal(mealId){
  try{
    await db.collection('plannings').doc(state.planningId).collection('meals').doc(mealId).delete();
    return true;
  }catch(e){
    console.error('Erreur suppression repas', e);
    await showAlert("Ce repas n'a pas pu être supprimé (droits insuffisants ou connexion coupée).");
    return false;
  }
}

async function saveMealsReactions(mealIds){
  if(!mealIds.length) return true;
  try{
    const batch = db.batch();
    const mealsRef = db.collection('plannings').doc(state.planningId).collection('meals');
    mealIds.forEach(id => {
      const meal = planningData.meals.find(m => m.id === id);
      if(meal) batch.update(mealsRef.doc(id), { reactions: meal.reactions || {} });
    });
    await batch.commit();
    return true;
  }catch(e){
    console.error('Erreur sauvegarde réaction', e);
    await showAlert("Cette réaction n'a pas pu être enregistrée (droits insuffisants ou connexion coupée).");
    return false;
  }
}

// ============================================================
// COMPTES & DROITS D'ACCÈS (Firebase Authentication)
// Chaque planning a des membres (administrateur ou lecture seule),
// retrouvés et gérés via l'email ou le numéro de téléphone des comptes —
// il n'y a plus de code à partager.
// ============================================================

// Ramène un numéro de téléphone à une forme unique, que la personne l'ait
// tapé en "06..." ou en "+33 6...", pour que ce soit reconnu comme le même
// numéro partout dans l'app.
function normalizePhone(phone){
  let digits = (phone || '').replace(/[^\d+]/g, '');
  if(digits.startsWith('+')) digits = '+' + digits.slice(1).replace(/\D/g, '');
  else digits = digits.replace(/\D/g, '');
  if(digits.startsWith('00')) digits = '+' + digits.slice(2);
  else if(digits.startsWith('0')) digits = '+33' + digits.slice(1);
  else if(!digits.startsWith('+')) digits = '+' + digits;
  return digits;
}

function normalizeIdentifier(str){
  const trimmed = (str || '').trim();
  if(!trimmed) return '';
  if(trimmed.includes('@')) return trimmed.toLowerCase().replace(/\s+/g, '');
  return normalizePhone(trimmed);
}

// Convertit un numéro de téléphone en "email" interne : Firebase ne propose
// nativement que téléphone + code SMS (payant au-delà d'un petit quota),
// pas téléphone + mot de passe. On réutilise donc son système email/mot de
// passe en coulisses, avec un email fabriqué à partir du numéro normalisé.
function phoneToSyntheticEmail(phone){
  const digits = normalizePhone(phone).replace(/[^0-9]/g, '');
  return `tel${digits}@petitescuilleres-users.app`;
}

// Enregistre le compte dans l'annuaire (email ou téléphone -> uid), pour
// qu'un administrateur puisse donner accès à quelqu'un en tapant juste son
// email ou son numéro.
async function registerUserLookup(identifier){
  const norm = normalizeIdentifier(identifier);
  if(!norm || !auth.currentUser) return;
  try{ await db.collection('userLookup').doc(norm).set({ uid: auth.currentUser.uid }); }
  catch(e){ console.error('Erreur enregistrement annuaire', e); }
}

async function saveUserProfile(fields){
  if(!auth.currentUser) return;
  try{ await db.collection('users').doc(auth.currentUser.uid).set(fields, { merge: true }); }
  catch(e){ console.error('Erreur profil utilisateur', e); }
}

// Rend le compte connecté membre de ce planning (utilisé à sa création).
async function ensureMembership(planningId, role, identifier){
  if(!auth.currentUser || !planningId || !role) return;
  const norm = normalizeIdentifier(identifier || '');
  const pseudo = (state.userProfile && state.userProfile.pseudo) || '';
  try{
    await db.collection('memberships').doc(auth.currentUser.uid).collection('plannings').doc(planningId).set({
      role, planningId, updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    await db.collection('planningMembers').doc(planningId).collection('members').doc(auth.currentUser.uid).set({
      role, identifier: norm, pseudo, updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  }catch(e){ console.error('Erreur création accès', e); }
}

// Met à jour le pseudo affiché de ce compte sur tous les plannings auxquels
// il a accès (utilisé après la saisie initiale, ou après une modification
// depuis l'onglet Partage).
async function updatePseudoEverywhere(pseudo){
  for(const p of state.knownPlannings){
    try{
      await db.collection('planningMembers').doc(p.planningId).collection('members').doc(auth.currentUser.uid).set({ pseudo }, { merge: true });
    }catch(e){}
  }
}

// Enregistre le pseudo choisi à l'inscription, puis reprend le fil normal.
async function submitPseudo(pseudo){
  await saveUserProfile({ pseudo });
  state.needsPseudo = false;
  await loadUserProfile();
  await loadLocal();
  await updatePseudoEverywhere(pseudo);
}

// Donne accès à ce planning à la personne identifiée par cet email ou ce
// numéro (elle doit déjà avoir un compte Petites Cuillères).
async function grantAccess(planningId, identifier, role){
  const norm = normalizeIdentifier(identifier);
  if(!norm) return { ok: false, error: "Entre un email ou un numéro de téléphone." };
  try{
    const lookup = await db.collection('userLookup').doc(norm).get();
    if(!lookup.exists){
      // Personne n'a encore de compte avec cet identifiant : on vérifie
      // d'abord qu'elle n'a pas déjà été invitée, puis on enregistre
      // l'invitation, appliquée automatiquement dès son inscription.
      const existingInvite = await db.collection('pendingInvites').doc(norm).collection('invites').doc(planningId).get();
      if(existingInvite.exists){
        return { ok: false, error: "Cette personne a déjà été invitée sur ce planning." };
      }
      await db.collection('pendingInvites').doc(norm).collection('invites').doc(planningId).set({
        role, updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      return { ok: true, pending: true };
    }
    const targetUid = lookup.data().uid;
    const existingMember = await db.collection('planningMembers').doc(planningId).collection('members').doc(targetUid).get();
    if(existingMember.exists && existingMember.data().role === role){
      return { ok: false, error: "Cette personne a déjà cet accès." };
    }
    await db.collection('memberships').doc(targetUid).collection('plannings').doc(planningId).set({
      role, planningId, updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    await db.collection('planningMembers').doc(planningId).collection('members').doc(targetUid).set({
      role, identifier: norm, updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    return { ok: true, pending: false, updated: existingMember.exists };
  }catch(e){
    console.error('Erreur attribution accès', e);
    const detail = e && e.code ? ` (${e.code})` : '';
    return { ok: false, error: `Une erreur est survenue${detail}, réessaie.` };
  }
}

// Applique les invitations en attente correspondant à cet email ou ce
// numéro — appelé juste après la création d'un compte.
async function consumePendingInvites(identifier){
  const norm = normalizeIdentifier(identifier);
  if(!norm || !auth.currentUser) return;
  try{
    const snap = await db.collection('pendingInvites').doc(norm).collection('invites').get();
    for(const doc of snap.docs){
      const planningId = doc.id;
      const role = doc.data().role;
      await db.collection('memberships').doc(auth.currentUser.uid).collection('plannings').doc(planningId).set({
        role, planningId, updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      await db.collection('planningMembers').doc(planningId).collection('members').doc(auth.currentUser.uid).set({
        role, identifier: norm, updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      await doc.ref.delete();
    }
  }catch(e){ console.error('Erreur consommation invitations', e); }
}

async function revokeAccess(planningId, uid){
  try{
    await db.collection('planningMembers').doc(planningId).collection('members').doc(uid).delete();
    await db.collection('memberships').doc(uid).collection('plannings').doc(planningId).delete();
    return true;
  }catch(e){ console.error('Erreur retrait accès', e); return false; }
}

async function listPlanningMembers(planningId){
  try{
    const snap = await db.collection('planningMembers').doc(planningId).collection('members').get();
    return snap.docs.map(d => ({ uid: d.id, ...d.data() }));
  }catch(e){ console.error('Erreur liste des membres', e); return []; }
}

// Reconstruit la liste des bébés accessibles pour ce compte à partir de
// Firestore — utile par exemple si un accès a été donné par un
// administrateur, ou depuis un autre appareil.
async function refreshKnownPlanningsFromMemberships(){
  if(!auth.currentUser) return;
  try{
    const snap = await db.collection('memberships').doc(auth.currentUser.uid).collection('plannings').get();
    const list = [];
    for(const doc of snap.docs){
      const planningId = doc.id;
      const role = doc.data().role;
      let babyName = '', photo = '';
      try{
        const dataDoc = await storageAPI.get('data:' + planningId, true);
        if(dataDoc && dataDoc.value){
          const parsed = JSON.parse(dataDoc.value);
          babyName = parsed.babyName || '';
          photo = parsed.photo || '';
        }
      }catch(e){}
      list.push({ planningId, role, babyName, photo });
    }
    state.knownPlannings = list;
    await storageAPI.set('my-plannings', JSON.stringify(state.knownPlannings), false);
  }catch(e){ console.error('Erreur rafraîchissement des accès', e); }
}

function authErrorMessage(e, context){
  const noun = context === 'phone' ? 'numéro' : 'email';
  const map = {
    'auth/email-already-in-use': `Un compte existe déjà avec cet ${noun}.`,
    'auth/invalid-email': context === 'phone' ? 'Numéro de téléphone invalide.' : 'Adresse email invalide.',
    'auth/weak-password': 'Le mot de passe doit faire au moins 6 caractères.',
    'auth/user-not-found': `Aucun compte avec cet ${noun}.`,
    'auth/wrong-password': 'Mot de passe incorrect.',
    'auth/invalid-credential': `${context === 'phone' ? 'Numéro' : 'Email'} ou mot de passe incorrect.`,
    'auth/too-many-requests': 'Trop de tentatives, réessaie dans quelques minutes.',
    'auth/unauthorized-domain': "Ce site n'est pas encore autorisé pour la connexion Google (Firebase Console > Authentication > Settings > Authorized domains).",
    'auth/operation-not-allowed': "La connexion Google n'est pas activée sur ce projet (Firebase Console > Authentication > Sign-in method).",
    'auth/network-request-failed': 'Problème de connexion internet, réessaie.',
    'auth/popup-blocked': "Le navigateur a bloqué la fenêtre de connexion Google. Autorise les popups pour ce site et réessaie."
  };
  const silent = ['auth/popup-closed-by-user', 'auth/cancelled-popup-request'];
  if(e && silent.includes(e.code)) return null;
  console.error('Erreur auth', e);
  if(e && map[e.code]) return map[e.code];
  if(e && e.code) return `Une erreur est survenue (${e.code}). Réessaie.`;
  return "Une erreur est survenue, réessaie.";
}

let pendingSignupIdentifier = null; // {identifier, method} en attente d'enregistrement après création du compte

async function signUpWithEmail(email, password){
  state.authBusy = true; state.authError = null; render();
  pendingSignupIdentifier = { identifier: email, method: 'email' };
  try{ await auth.createUserWithEmailAndPassword(email, password); }
  catch(e){ pendingSignupIdentifier = null; state.authError = authErrorMessage(e, 'email'); state.authBusy = false; render(); }
}

async function logInWithEmail(email, password){
  state.authBusy = true; state.authError = null; render();
  try{ await auth.signInWithEmailAndPassword(email, password); }
  catch(e){ state.authError = authErrorMessage(e, 'email'); state.authBusy = false; render(); }
}

async function signUpWithPhone(phone, password){
  state.authBusy = true; state.authError = null; render();
  pendingSignupIdentifier = { identifier: phone, method: 'phone' };
  try{ await auth.createUserWithEmailAndPassword(phoneToSyntheticEmail(phone), password); }
  catch(e){ pendingSignupIdentifier = null; state.authError = authErrorMessage(e, 'phone'); state.authBusy = false; render(); }
}

async function logInWithPhone(phone, password){
  state.authBusy = true; state.authError = null; render();
  try{ await auth.signInWithEmailAndPassword(phoneToSyntheticEmail(phone), password); }
  catch(e){ state.authError = authErrorMessage(e, 'phone'); state.authBusy = false; render(); }
}

async function signInWithGoogle(){
  state.authError = null;
  state.authBusy = true; render();
  try{
    const result = await auth.signInWithPopup(new firebase.auth.GoogleAuthProvider());
    if(result && result.user && result.user.email){
      pendingSignupIdentifier = { identifier: result.user.email, method: 'google' };
    }
  }catch(e){
    state.authError = authErrorMessage(e, 'email');
  }
  state.authBusy = false;
  render();
}

async function sendPasswordReset(email){
  if(!email){ state.authError = "Entre ton email dans le champ ci-dessus, puis retape sur ce lien."; render(); return; }
  try{
    await auth.sendPasswordResetEmail(email);
    state.authError = null;
    render();
    await showAlert("Email de réinitialisation envoyé si un compte existe avec cette adresse.");
  }catch(e){ state.authError = authErrorMessage(e); render(); }
}

async function logOut(){
  unsubscribePlanning();
  await auth.signOut();
  state.tab = 'planning';
  state.showCreate = false;
  state.needsPseudo = false;
  state.authScreen = 'landing';
  state.authMethod = 'email';
  state.grantError = null;
  state.grantSuccessMessage = null;
  state.inviteRole = null;
  createGender = null;
  createPhoto = null;
  planningMembers = [];
  planningMembersForId = null;
}

async function createPlanning(babyName, birthdate, gender, photo){
  const planningId = randomCode(10);
  const profileFields = { babyName, birthdate: birthdate || null, gender: gender || null, photo: photo || null };
  try{
    const myIdentifier = state.userProfile && (state.userProfile.phone || state.userProfile.email);
    await ensureMembership(planningId, 'edit', myIdentifier);
    await db.collection(COLLECTION).doc('data:' + planningId).set(profileFields);
    state.planningId = planningId;
    state.role = 'edit';
    await subscribeToPlanning(planningId);
    await saveLocal();
    createPhoto = null;
    createGender = null;
    render();
  }catch(e){
    console.error('Erreur création du planning', e);
    await showAlert("La création du planning a échoué, réessaie.");
  }
}

function fmtDate(d){
  const dt = new Date(d);
  return dt.toLocaleDateString('fr-FR', {weekday:'long', day:'numeric', month:'long'});
}

function reactionConfig(val){
  return {
    aime: { icon: ICON_REACT_AIME, label:'Aimé', bg:'var(--success-bg)', text:'var(--success-text)' },
    mitige: { icon: ICON_REACT_MITIGE, label:'Mitigé', bg:'var(--warning-bg)', text:'var(--warning-text)' },
    allergie: { icon: ICON_REACT_ALLERGIE, label:'Allergie suspectée', bg:'var(--danger-bg)', text:'var(--danger-text)' }
  }[val];
}

function getMealFoods(m){
  return m.alimentsList && m.alimentsList.length
    ? m.alimentsList
    : (m.aliments || '').split(',').map(s => s.trim()).filter(Boolean);
}

function getMealReactions(m){
  if(m.reactions) return m.reactions;
  if(m.reaction){
    const map = {};
    getMealFoods(m).forEach(f => { map[f] = m.reaction; });
    return map;
  }
  return {};
}

function renderSplash(){
  return `
    <div style="min-height:100vh;min-height:100dvh;display:flex;align-items:center;justify-content:center;background:var(--primary);">
      <div style="width:180px;color:#FFFFFF;">${ICON_LOGO_WORDMARK}</div>
    </div>
  `;
}

function renderPseudoStep(){
  return `
    <div style="min-height:100vh;min-height:100dvh;display:flex;flex-direction:column;padding:2.5rem 1.5rem 2rem;">
      <div style="width:140px;color:var(--primary);margin:0 auto 2rem;">${ICON_LOGO_WORDMARK}</div>
      <div class="title-font" style="font-size:30px;color:var(--text);margin-bottom:8px;text-align:center;">Comment veux-tu qu'on t'appelle ?</div>
      <p style="font-size:16px;color:var(--text-secondary);text-align:center;margin:0 0 1.75rem;">Ce nom sera visible par les autres personnes qui partagent un planning avec toi.</p>
      <div class="field">
        <label>Prénom ou pseudo</label>
        <input type="text" id="pseudo-input" placeholder="Ex : Maman, Léo, Mamie..." autocomplete="nickname" />
      </div>
      <button class="btn btn-primary" id="submit-pseudo-btn" style="color:#FFFFFF;margin-top:0.5rem;">Continuer</button>
    </div>
  `;
}

function attachPseudoEvents(){
  const btn = document.getElementById('submit-pseudo-btn');
  const input = document.getElementById('pseudo-input');
  if(btn) btn.onclick = async () => {
    const val = input ? input.value.trim() : '';
    if(!val){ input.focus(); return; }
    btn.disabled = true; btn.textContent = '...';
    await submitPseudo(val);
  };
}

function render(){
  const app = document.getElementById('app');
  if(state.authLoading || state.loading){ app.innerHTML = renderSplash(); return; }
  if(!state.user){ app.innerHTML = renderAuthGate(); attachAuthEvents(); return; }
  if(state.needsPseudo){ app.innerHTML = renderPseudoStep(); attachPseudoEvents(); return; }
  if(!state.planningId){ app.innerHTML = renderWelcome(); attachWelcomeEvents(); return; }

  app.innerHTML = renderMain();
  attachMainEvents();
  fitModalToViewport();
  bindModalA11y();
}

// Recale les modales (fenêtre d'ajout de repas, édition de profil) sur la
// zone réellement visible à l'écran, pour qu'elles ne passent pas sous le
// clavier mobile (surtout utile sur iOS où le CSS seul ne suffit pas).
// Rend les fenetres modales (ajout de repas, changement de bebe, edition de
// profil/pseudo) utilisables au clavier et par un lecteur d'ecran : role
// dialog, focus pose sur le premier champ a l'ouverture, fermeture par la
// touche Echap (via le bouton de fermeture deja present dans chaque modale).
function bindModalA11y(){
  const overlay = document.querySelector('.modal-overlay');
  if(!overlay) return;
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  const focusTarget = overlay.querySelector('input, select, textarea, button');
  if(focusTarget) focusTarget.focus({ preventScroll: true });
  const onKey = (e) => {
    if(e.key !== 'Escape') return;
    document.removeEventListener('keydown', onKey);
    const closeBtn = overlay.querySelector('.modal-close-btn');
    if(closeBtn) closeBtn.click();
  };
  document.addEventListener('keydown', onKey);
}

function fitModalToViewport(){
  if(!window.visualViewport) return;
  const vv = window.visualViewport;
  document.querySelectorAll('.modal-overlay').forEach(el => {
    el.style.height = vv.height + 'px';
    el.style.top = vv.offsetTop + 'px';
  });
}
// Une fois le clavier réellement ouvert (l'événement resize du visualViewport
// ne se déclenche qu'à ce moment-là, contrairement à un simple timeout qui
// peut tomber trop tôt sur certains téléphones), on re-centre le champ actif
// pour être sûr qu'il reste au-dessus du clavier.
function scrollActiveFieldIntoView(){
  const el = document.activeElement;
  if(el && el.matches && el.matches('input, select, textarea')){
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}
if(window.visualViewport){
  window.visualViewport.addEventListener('resize', () => {
    fitModalToViewport();
    scrollActiveFieldIntoView();
  });
  window.visualViewport.addEventListener('scroll', fitModalToViewport);
}

function renderAuthGate(){
  if(state.authScreen === 'login') return renderAuthForm(false);
  if(state.authScreen === 'signup') return renderAuthForm(true);
  return renderAuthLanding();
}

function renderAuthLanding(){
  return `
    <div style="min-height:100vh;min-height:100dvh;display:flex;flex-direction:column;padding:2.5rem 1.5rem 2rem;">
      <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;">
        <div style="width:230px;color:var(--primary);">${ICON_LOGO_WORDMARK}</div>
        <p style="font-size:16px;color:var(--text-secondary);text-align:center;margin:1.25rem 0 0;max-width:280px;">Le carnet de la diversification alimentaire de bébé, à partager en famille.</p>
      </div>
      ${state.authError ? `<p class="error-text" style="text-align:center;margin-bottom:14px;">${state.authError}</p>` : ''}
      <div style="width:100%;">
        <button class="btn btn-primary" id="goto-signup-btn" style="margin-bottom:10px;color:#FFFFFF;">Créer un compte</button>
        <button class="btn btn-outline" id="goto-login-btn">Me connecter</button>
        <p style="font-size:13px;color:var(--text-muted);text-align:center;margin:14px 0 0;">En continuant, tu acceptes les <a href="./cgu.html" style="color:var(--text-muted);">CGU</a> et la <a href="./confidentialite.html" style="color:var(--text-muted);">politique de confidentialité</a>.</p>
        <p style="font-size:13px;color:var(--text-muted);text-align:center;margin:8px 0 0;"><a href="./blog/index.html" style="color:var(--text-muted);">Nos conseils sur la diversification alimentaire</a></p>
      </div>
    </div>
  `;
}

function renderAuthForm(isSignup){
  const isPhone = state.authMethod === 'phone';
  return `
    <div style="min-height:100vh;min-height:100dvh;display:flex;flex-direction:column;padding:2rem 1.5rem 2rem;">
      <button id="auth-back-btn" aria-label="Retour" ${state.authBusy ? 'disabled style="opacity:0.3;background:none;border:none;padding:8px;margin:-8px -8px 0.5rem;align-self:flex-start;color:var(--text);"' : 'style="background:none;border:none;padding:8px;margin:-8px -8px 0.5rem;align-self:flex-start;color:var(--text);cursor:pointer;"'}>${ICON_BACK}</button>
      <div style="width:120px;color:var(--primary);margin:0 auto 1.5rem;">${ICON_LOGO_WORDMARK}</div>
      <div class="title-font" style="font-size:30px;color:var(--text);margin-bottom:1.25rem;text-align:center;">${isSignup ? 'Créer un compte' : 'Se connecter'}</div>

      <div style="display:flex;gap:8px;margin-bottom:1.25rem;">
        <button class="btn ${!isPhone ? 'btn-primary' : 'btn-secondary'}" id="auth-method-email" style="height:38px;font-size:15px;${!isPhone ? 'color:#FFFFFF;' : ''}">Email</button>
        <button class="btn ${isPhone ? 'btn-primary' : 'btn-secondary'}" id="auth-method-phone" style="height:38px;font-size:15px;${isPhone ? 'color:#FFFFFF;' : ''}">Téléphone</button>
      </div>

      ${state.authError ? `<p class="error-text" style="text-align:center;margin-bottom:14px;">${state.authError}</p>` : ''}

      <div class="field">
        <label>${isPhone ? 'Numéro de téléphone' : 'Email'}</label>
        <input type="${isPhone ? 'tel' : 'email'}" id="auth-identifier-input" placeholder="${isPhone ? '+33 6 12 34 56 78' : 'toi@exemple.com'}" autocomplete="${isPhone ? 'tel' : 'email'}" />
      </div>
      <div class="field">
        <label>Mot de passe</label>
        <div style="position:relative;">
          <input type="password" id="auth-password-input" placeholder="••••••••" autocomplete="${isSignup ? 'new-password' : 'current-password'}" style="padding-right:48px;" />
          <button type="button" id="toggle-password-btn" aria-label="Afficher le mot de passe" style="position:absolute;right:14px;top:50%;transform:translateY(-50%);background:none;border:none;padding:4px;color:var(--text-muted);cursor:pointer;display:flex;">${ICON_EYE}</button>
        </div>
      </div>

      <button class="btn btn-primary" id="auth-submit-btn" style="color:#FFFFFF;" ${state.authBusy ? 'disabled' : ''}>
        ${state.authBusy ? (isSignup ? 'Création en cours...' : 'Connexion en cours...') : (isSignup ? 'Créer mon compte' : 'Se connecter')}
      </button>
      ${(!isSignup && !isPhone) ? `<button class="btn btn-ghost" id="forgot-password-btn" style="margin:4px auto 0;">Mot de passe oublié ?</button>` : ''}

      <div style="display:flex;align-items:center;gap:10px;margin:1.25rem 0;">
        <div style="flex:1;height:1px;background:var(--border);"></div>
        <span style="color:var(--text-muted);font-size:14px;">ou</span>
        <div style="flex:1;height:1px;background:var(--border);"></div>
      </div>

      <button class="btn btn-outline" id="google-signin-btn" ${state.authBusy ? 'disabled' : ''}>
        ${ICON_GOOGLE} Continuer avec Google
      </button>

      <button class="btn btn-ghost" id="toggle-auth-mode-btn" style="margin-top:1.5rem;">
        ${isSignup ? 'Déjà un compte ? Se connecter' : "Pas de compte ? En créer un"}
      </button>
    </div>
  `;
}

function attachAuthEvents(){
  const signupBtn = document.getElementById('goto-signup-btn');
  if(signupBtn) signupBtn.onclick = () => { state.authScreen = 'signup'; state.authError = null; render(); };
  const loginBtn = document.getElementById('goto-login-btn');
  if(loginBtn) loginBtn.onclick = () => { state.authScreen = 'login'; state.authError = null; render(); };
  const backBtn = document.getElementById('auth-back-btn');
  if(backBtn) backBtn.onclick = () => { if(state.authBusy) return; state.authScreen = 'landing'; state.authError = null; render(); };

  const methodEmailBtn = document.getElementById('auth-method-email');
  if(methodEmailBtn) methodEmailBtn.onclick = () => switchAuthMethod('email');
  const methodPhoneBtn = document.getElementById('auth-method-phone');
  if(methodPhoneBtn) methodPhoneBtn.onclick = () => switchAuthMethod('phone');

  const togglePasswordBtn = document.getElementById('toggle-password-btn');
  if(togglePasswordBtn) togglePasswordBtn.onclick = () => {
    const input = document.getElementById('auth-password-input');
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    togglePasswordBtn.innerHTML = showing ? ICON_EYE : ICON_EYE_OFF;
    togglePasswordBtn.setAttribute('aria-label', showing ? 'Afficher le mot de passe' : 'Masquer le mot de passe');
  };

  const submitBtn = document.getElementById('auth-submit-btn');
  if(submitBtn) submitBtn.onclick = () => {
    const identifier = document.getElementById('auth-identifier-input').value.trim();
    const password = document.getElementById('auth-password-input').value;
    if(!identifier || !password){ state.authError = 'Remplis les deux champs.'; render(); return; }
    const isPhone = state.authMethod === 'phone';
    if(state.authScreen === 'signup'){
      if(isPhone) signUpWithPhone(identifier, password);
      else signUpWithEmail(identifier, password);
    } else {
      if(isPhone) logInWithPhone(identifier, password);
      else logInWithEmail(identifier, password);
    }
  };
  const googleBtn = document.getElementById('google-signin-btn');
  if(googleBtn) googleBtn.onclick = () => signInWithGoogle();
  const toggleBtn = document.getElementById('toggle-auth-mode-btn');
  if(toggleBtn) toggleBtn.onclick = () => {
    const savedId = document.getElementById('auth-identifier-input').value;
    const savedPw = document.getElementById('auth-password-input').value;
    state.authScreen = state.authScreen === 'signup' ? 'login' : 'signup';
    state.authError = null;
    render();
    const newId = document.getElementById('auth-identifier-input');
    const newPw = document.getElementById('auth-password-input');
    if(newId) newId.value = savedId;
    if(newPw) newPw.value = savedPw;
  };
  const forgotBtn = document.getElementById('forgot-password-btn');
  if(forgotBtn) forgotBtn.onclick = () => {
    const email = document.getElementById('auth-identifier-input').value.trim();
    sendPasswordReset(email);
  };
}

function switchAuthMethod(method){
  const savedPw = document.getElementById('auth-password-input').value;
  state.authMethod = method;
  state.authError = null;
  render();
  const newPw = document.getElementById('auth-password-input');
  if(newPw) newPw.value = savedPw;
}

function renderWelcome(){
  if(state.showCreate || state.knownPlannings.length === 0) return renderCreateForm();
  return renderWelcomeReturning();
}

// Écran affiché à un utilisateur qui a déjà au moins un bébé enregistré sur
// cet appareil : on va droit au but (sa liste de bébés), sans repasser par
// l'argumentaire marketing à chaque ouverture.
function renderWelcomeReturning(){
  return `
    <div style="min-height:100vh;min-height:100dvh;display:flex;flex-direction:column;padding:2.5rem 1.5rem 2rem;">
      <div style="width:100px;color:var(--primary);margin:0 auto 2rem;">${ICON_LOGO_WORDMARK}</div>
      <div class="title-font" style="font-size:30px;color:var(--text);margin-bottom:14px;">Tes bébés</div>
      <div style="width:100%;">
        ${state.knownPlannings.map(p => {
          const avatarStyle = p.photo ? `background-image:url('${escapeHtml(p.photo)}');background-size:cover;background-position:center;` : 'background:var(--accent-light);';
          return `
          <button class="baby-list-item" data-switchid="${p.planningId}" data-switchrole="${p.role}">
            <span class="avatar" style="width:48px;height:48px;flex-shrink:0;color:var(--accent);${avatarStyle}">${p.photo ? '' : ICON_BABY_SILHOUETTE}</span>
            <span style="flex:1;min-width:0;">
              <span style="display:block;font-weight:700;font-size:17px;color:var(--text);">${escapeHtml(p.babyName) || 'Bébé'}</span>
              <span style="display:block;font-size:14px;color:var(--text-muted);">${p.role === 'edit' ? 'Administrateur' : 'Lecture seule'}</span>
            </span>
            <span style="color:var(--text-muted);font-size:22px;line-height:1;">›</span>
          </button>
        `;}).join('')}
      </div>
      <div style="margin-top:auto;width:100%;padding-top:1.5rem;">
        <button class="btn btn-primary" id="btn-create" style="color:#FFFFFF;">
          Ajouter un autre bébé
        </button>
        <p style="font-size:14px;color:var(--text-muted);text-align:center;margin:10px 0 0;">Pour un autre bébé, demande à un administrateur de te donner accès depuis l'onglet Partage, avec cet email ou ce numéro.</p>
      </div>
    </div>
  `;
}

let createGender = null;
let createPhoto = null;

function renderCreateForm(){
  const todayStr = localDateStr(new Date());
  const minDate = new Date();
  minDate.setFullYear(minDate.getFullYear() - 100);
  const minStr = localDateStr(minDate);
  const hasBack = state.knownPlannings.length > 0;
  const photoStyle = createPhoto ? `background-image:url('${escapeHtml(createPhoto)}');background-size:cover;background-position:center;` : '';
  return `
    <div class="top-header" style="justify-content:center;padding-top:2rem;">
      <div style="display:flex;flex-direction:column;align-items:center;">
        <button id="create-photo-btn" class="avatar" aria-label="Ajouter une photo de bébé" style="width:130px;height:130px;font-size:52px;border:none;cursor:pointer;overflow:hidden;display:flex;align-items:center;justify-content:center;color:var(--accent);${photoStyle || 'background:var(--accent-light);'}">${createPhoto ? '' : ICON_BABY_SILHOUETTE}</button>
        <input type="file" id="create-photo-input" accept="image/*" style="display:none;" />
        <div style="font-size:14px;color:var(--text-muted);margin-top:8px;">Touche pour ajouter une photo</div>
      </div>
    </div>
    <div class="screen" style="padding-top:1rem;">
      ${hasBack ? `<button class="header-icon-btn" id="back-btn" style="margin:0 0 1rem -6px;padding:0;opacity:1;" aria-label="Retour">${ICON_BACK}</button>` : ''}
      <div class="field">
        <label>Prénom</label>
        <input type="text" id="baby-name-input" placeholder="Ex : Léa" />
        <p class="error-text" id="name-error" style="display:none;">Indique un prénom</p>
      </div>
      <div class="field">
        <label>Date de naissance</label>
        <input type="date" id="baby-birthdate-input" min="${minStr}" max="${todayStr}" />
        <p class="error-text" id="birthdate-error" style="display:none;">Indique la date de naissance</p>
        <p class="error-text" id="birthdate-range-error" style="display:none;">Erreur de date</p>
      </div>
      <div class="field">
        <label>Sexe</label>
        <div class="gender-toggle">
          <button type="button" class="gender-btn" id="gender-fille" data-val="fille">♀ Fille</button>
          <button type="button" class="gender-btn" id="gender-garcon" data-val="garcon">♂ Garçon</button>
        </div>
        <p class="error-text" id="gender-error" style="display:none;">Sélectionne le sexe de bébé</p>
      </div>
      <button class="btn btn-primary" id="submit-create" style="margin-top:0.5rem;">Créer le planning</button>
      <button class="btn btn-ghost" id="skip-create-btn" style="margin-top:0.75rem;">On m'a déjà donné accès à un bébé</button>
    </div>
  `;
}

function autoMigratePastMeals(){
  const now = new Date();
  const toUpdate = [];
  planningData.meals.forEach(m => {
    if(m.statut === 'futur' && m.date){
      const mealDateTime = new Date(m.date + 'T' + (m.heure || '23:59'));
      if(mealDateTime.getTime() < now.getTime()){
        m.statut = 'passe';
        toUpdate.push(m.id);
      }
    }
  });
  // Un lecteur seul n'a pas le droit d'ecrire "statut" (seul "reactions"
  // lui est autorise) : le changement reste local a son affichage, un
  // administrateur le persistera a sa prochaine ouverture de l'app.
  if(toUpdate.length && state.role === 'edit'){
    const batch = db.batch();
    const mealsRef = db.collection('plannings').doc(state.planningId).collection('meals');
    toUpdate.forEach(id => batch.update(mealsRef.doc(id), { statut: 'passe' }));
    batch.commit().catch(e => console.error('Erreur mise à jour automatique des statuts', e));
  }
}

const ICON_CALENDAR = `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M7 2a1 1 0 0 1 1 1v1h8V3a1 1 0 1 1 2 0v1h1a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h1V3a1 1 0 0 1 1-1zM4 10v9a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-9H4zm3 2h3v3H7v-3zm5 0h3v3h-3v-3z"/></svg>`;
const ICON_HISTORY = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><polyline points="3 3 3 8 8 8"/><polyline points="12 7 12 12 15 14"/></svg>`;
const ICON_SETTINGS = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;
const ICON_BACK = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 5 5 12 12 19"/></svg>`;
const ICON_EYE = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z"/><circle cx="12" cy="12" r="3"/></svg>`;
const ICON_EYE_OFF = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a20.3 20.3 0 0 1 5.06-5.94M9.9 4.24A10.4 10.4 0 0 1 12 4c7 0 11 8 11 8a20.3 20.3 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;
const ICON_TRASH = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 7 20 7"/><path d="M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13"/><path d="M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>`;
const ICON_EDIT = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`;
const ICON_PLUS = `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;

const ICON_LOGO_WORDMARK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="163.53 488.73 1172.59 557.78" preserveAspectRatio="xMidYMid meet" style="width:100%;height:auto;display:block;"><g transform="matrix(1, 0, 0, 1, 1000, 620)"><g fill="currentColor" fill-opacity="1" transform="translate(7.877765, 346.887465)"><path d="M 141.84375 -108.671875 L 141.921875 -109.75 L 141.828125 -110.859375 L 141.984375 -112.828125 C 141.859375 -114.285156 141.816406 -115.316406 141.859375 -115.921875 C 142.390625 -122.890625 139.738281 -129.34375 133.90625 -135.28125 C 128.070312 -141.226562 121.492188 -144.476562 114.171875 -145.03125 L 108.765625 -145.4375 C 98.671875 -146.207031 89.898438 -142.945312 82.453125 -135.65625 C 75.015625 -128.363281 70.925781 -119.914062 70.1875 -110.3125 L 69.96875 -107.421875 C 69.695312 -103.816406 71.90625 -101.835938 76.59375 -101.484375 L 81.046875 -100.59375 L 92.40625 -99.734375 L 93.3125 -99.84375 L 126.4375 -99.140625 L 130.25 -99.21875 C 137.457031 -98.675781 141.320312 -101.828125 141.84375 -108.671875 Z M 171.078125 -73.453125 C 160.796875 -70.242188 141.207031 -69.738281 112.3125 -71.9375 C 83.414062 -74.132812 68.640625 -70.910156 67.984375 -62.265625 C 67.117188 -50.847656 70.820312 -41.5625 79.09375 -34.40625 C 87.375 -27.25 99.625 -23.054688 115.84375 -21.828125 C 122.09375 -21.347656 130.144531 -22.304688 140 -24.703125 C 149.851562 -27.097656 157.476562 -28.085938 162.875 -27.671875 C 169.488281 -27.171875 172.394531 -21.632812 171.59375 -11.0625 C 171.082031 -4.332031 163.351562 1.539062 148.40625 6.5625 C 133.46875 11.59375 119.207031 13.59375 105.625 12.5625 L 101.484375 12.234375 C 86.703125 11.117188 73.863281 7.882812 62.96875 2.53125 C 52.082031 -2.820312 43.59375 -9.175781 37.5 -16.53125 C 31.414062 -23.894531 26.675781 -33.441406 23.28125 -45.171875 C 19.882812 -56.910156 18.71875 -69.75 19.78125 -83.6875 L 20.109375 -88.015625 C 22.265625 -116.367188 31.113281 -138.171875 46.65625 -153.421875 C 54.863281 -161.503906 64.789062 -167.425781 76.4375 -171.1875 C 88.09375 -174.957031 100.171875 -176.363281 112.671875 -175.40625 L 121.140625 -174.765625 C 129.671875 -174.117188 138.429688 -171.757812 147.421875 -167.6875 C 164.828125 -159.84375 176.296875 -146.164062 181.828125 -126.65625 C 184.578125 -116.90625 185.632812 -107.820312 185 -99.40625 L 184.703125 -95.453125 C 183.773438 -83.304688 179.234375 -75.972656 171.078125 -73.453125 Z M 171.078125 -73.453125 "/></g></g><g transform="matrix(1, 0, 0, 1, 874, 653)"><g fill="currentColor" fill-opacity="1" transform="translate(11.371078, 352.224353)"><path d="M 37.9375 -180.375 L 44.25 -180.578125 C 57.019531 -180.867188 65.941406 -176.992188 71.015625 -168.953125 C 72.660156 -166.359375 74.234375 -165.082031 75.734375 -165.125 C 77.242188 -165.175781 80.238281 -166.710938 84.71875 -169.734375 C 89.207031 -172.765625 93.941406 -175.59375 98.921875 -178.21875 C 103.898438 -180.851562 110.363281 -182.296875 118.3125 -182.546875 C 126.269531 -182.796875 132.257812 -181.207031 136.28125 -177.78125 C 140.3125 -174.351562 142.40625 -170.015625 142.5625 -164.765625 C 142.726562 -159.523438 141.203125 -154.414062 137.984375 -149.4375 C 134.773438 -144.457031 130.457031 -141.882812 125.03125 -141.71875 L 102.734375 -143.359375 C 99.003906 -143.242188 94.6875 -141.539062 89.78125 -138.25 C 84.882812 -134.96875 81.035156 -129.90625 78.234375 -123.0625 C 75.429688 -116.226562 74.253906 -105.613281 74.703125 -91.21875 C 75.160156 -76.832031 77.207031 -63.539062 80.84375 -51.34375 C 84.46875 -39.40625 86.390625 -30.066406 86.609375 -23.328125 C 87.023438 -9.835938 74.890625 -2.707031 50.203125 -1.9375 L 46.765625 -1.828125 C 30.023438 -1.304688 21.457031 -7.367188 21.0625 -20.015625 C 20.945312 -23.742188 22.003906 -29.347656 24.234375 -36.828125 C 26.472656 -44.304688 27.789062 -50.4375 28.1875 -55.21875 C 28.582031 -60 28.4375 -73.347656 27.75 -95.265625 C 27.0625 -117.179688 26.222656 -130.503906 25.234375 -135.234375 C 24.242188 -139.960938 22.34375 -144.84375 19.53125 -149.875 C 16.71875 -154.914062 15.242188 -159.601562 15.109375 -163.9375 C 14.972656 -168.28125 16.90625 -172.046875 20.90625 -175.234375 C 24.90625 -178.429688 30.582031 -180.144531 37.9375 -180.375 Z M 37.9375 -180.375 "/></g></g><g transform="matrix(1, 0, 0, 1, 694, 667)"><g fill="currentColor" fill-opacity="1" transform="translate(13.597583, 344.063369)"><path d="M 79.421875 -108.390625 L 79.109375 -106.234375 C 78.359375 -101.109375 84.546875 -97.582031 97.671875 -95.65625 L 98.734375 -95.5 L 99.84375 -95.515625 L 115.96875 -93.359375 C 138.132812 -90.109375 149.601562 -91.109375 150.375 -96.359375 L 151.15625 -101.71875 C 152.488281 -110.78125 150.75 -119.039062 145.9375 -126.5 C 141.125 -133.957031 134.066406 -138.367188 124.765625 -139.734375 L 119.21875 -140.546875 C 109.925781 -141.910156 101.378906 -139.691406 93.578125 -133.890625 C 85.773438 -128.085938 81.054688 -119.585938 79.421875 -108.390625 Z M 88.484375 -248.796875 L 88.890625 -251.484375 C 89.097656 -252.910156 91.164062 -254.554688 95.09375 -256.421875 C 99.019531 -258.285156 103.660156 -258.828125 109.015625 -258.046875 L 110.078125 -257.703125 L 111.140625 -257.546875 C 121.753906 -255.992188 129.644531 -251.242188 134.8125 -243.296875 C 150.84375 -218.898438 158.21875 -202.351562 156.9375 -193.65625 L 156.6875 -191.859375 C 156.070312 -187.691406 152.128906 -186.140625 144.859375 -187.203125 L 141.828125 -187.65625 C 134.304688 -188.757812 126.203125 -194.570312 117.515625 -205.09375 C 97.453125 -229.34375 87.773438 -243.910156 88.484375 -248.796875 Z M 106.734375 18.375 L 98.15625 17.109375 C 87.539062 15.554688 76.789062 12.03125 65.90625 6.53125 C 44.925781 -4.082031 32.0625 -20.628906 27.3125 -43.109375 C 24.664062 -55.804688 24.207031 -68.054688 25.9375 -79.859375 L 27.8125 -92.734375 C 29.75 -105.972656 33.734375 -118.179688 39.765625 -129.359375 C 50.671875 -149.804688 67.289062 -162.648438 89.625 -167.890625 C 100.582031 -170.441406 113.039062 -170.695312 127 -168.65625 L 131.28125 -168.015625 C 142.488281 -166.378906 152.585938 -163.015625 161.578125 -157.921875 C 178.910156 -148.203125 189.503906 -133.625 193.359375 -114.1875 C 195.390625 -104.019531 195.796875 -94.757812 194.578125 -86.40625 L 194 -82.46875 C 192.101562 -69.476562 187.6875 -62.148438 180.75 -60.484375 C 173.8125 -58.828125 158 -59.804688 133.3125 -63.421875 C 108.632812 -67.035156 93.910156 -68.757812 89.140625 -68.59375 C 79.835938 -68.257812 74.804688 -65.523438 74.046875 -60.390625 C 72.378906 -48.953125 75.804688 -38.648438 84.328125 -29.484375 C 90.535156 -22.847656 102.109375 -18.289062 119.046875 -15.8125 C 125.472656 -14.875 133.6875 -15.070312 143.6875 -16.40625 C 153.695312 -17.738281 161.617188 -17.976562 167.453125 -17.125 C 174.015625 -16.164062 176.691406 -11.570312 175.484375 -3.34375 C 174.285156 4.875 167.503906 10.878906 155.140625 14.671875 C 139.316406 19.546875 123.179688 20.78125 106.734375 18.375 Z M 106.734375 18.375 "/></g></g><g transform="matrix(1, 0, 0, 1, 625, 696)"><g fill="currentColor" fill-opacity="1" transform="translate(11.351034, 351.527044)"><path d="M 66.5 -1.46875 L 52.765625 -1.046875 C 42.773438 -0.742188 35.613281 -2.335938 31.28125 -5.828125 C 26.957031 -9.316406 24.6875 -14.671875 24.46875 -21.890625 C 24.414062 -23.703125 24.847656 -27.394531 25.765625 -32.96875 L 26.859375 -38.609375 C 29.578125 -52.421875 30.816406 -63.242188 30.578125 -71.078125 L 30.125 -86.25 L 30.078125 -93.125 L 29.34375 -117.703125 L 29.203125 -128.171875 L 28.671875 -145.703125 C 27.304688 -190.753906 26.378906 -215.289062 25.890625 -219.3125 C 25.410156 -223.332031 23.488281 -229.117188 20.125 -236.671875 C 16.757812 -244.234375 15.050781 -248.851562 15 -250.53125 L 14.90625 -253.59375 C 14.75 -258.78125 17.203125 -262.351562 22.265625 -264.3125 C 27.335938 -266.28125 35.984375 -267.445312 48.203125 -267.8125 C 60.429688 -268.1875 67.707031 -263.882812 70.03125 -254.90625 C 70.300781 -253.820312 70.863281 -239.132812 71.71875 -210.84375 L 71.671875 -207.21875 C 71.734375 -204.9375 71.800781 -202.648438 71.875 -200.359375 L 72.015625 -189.6875 L 72.53125 -172.359375 L 72.546875 -165.46875 C 74.273438 -108.632812 75.832031 -76.257812 77.21875 -68.34375 C 78.601562 -60.425781 82.03125 -50.613281 87.5 -38.90625 C 92.976562 -27.195312 95.726562 -21.101562 95.75 -20.625 C 96.113281 -8.457031 86.363281 -2.070312 66.5 -1.46875 Z M 66.5 -1.46875 "/></g></g><g transform="matrix(1, 0, 0, 1, 551, 679)"><g fill="currentColor" fill-opacity="1" transform="translate(0.829712, 347.68437)"><path d="M 66.515625 0.546875 L 52.78125 0.546875 C 42.78125 0.546875 35.671875 -1.257812 31.453125 -4.875 C 27.234375 -8.488281 25.125 -13.910156 25.125 -21.140625 C 25.125 -22.953125 25.664062 -26.628906 26.75 -32.171875 L 28.015625 -37.78125 C 31.148438 -51.507812 32.71875 -62.289062 32.71875 -70.125 L 32.71875 -85.3125 L 32.890625 -92.171875 L 32.890625 -116.765625 L 33.078125 -127.234375 L 33.078125 -144.765625 C 33.078125 -189.835938 32.894531 -214.390625 32.53125 -218.421875 C 32.164062 -222.460938 30.414062 -228.304688 27.28125 -235.953125 C 24.15625 -243.609375 22.59375 -248.28125 22.59375 -249.96875 L 22.59375 -253.03125 C 22.59375 -258.21875 25.148438 -261.710938 30.265625 -263.515625 C 35.390625 -265.328125 44.066406 -266.234375 56.296875 -266.234375 C 68.523438 -266.234375 75.664062 -261.710938 77.71875 -252.671875 C 77.957031 -251.585938 78.078125 -236.890625 78.078125 -208.578125 L 77.90625 -204.953125 C 77.90625 -202.671875 77.90625 -200.382812 77.90625 -198.09375 L 77.71875 -187.421875 L 77.71875 -170.078125 L 77.53125 -163.203125 C 77.53125 -106.335938 78.101562 -73.925781 79.25 -65.96875 C 80.394531 -58.019531 83.523438 -48.109375 88.640625 -36.234375 C 93.765625 -24.367188 96.328125 -18.195312 96.328125 -17.71875 C 96.328125 -5.539062 86.390625 0.546875 66.515625 0.546875 Z M 66.515625 0.546875 "/></g></g><g transform="matrix(1, 0, 0, 1, 482, 698)"><g fill="currentColor" fill-opacity="1" transform="translate(0.73632, 347.846224)"><path d="M 54.21875 -258.8125 L 56.9375 -258.8125 C 73.195312 -258.8125 81.328125 -252.304688 81.328125 -239.296875 L 81.328125 -232.4375 C 80.972656 -230.625 80.796875 -228.390625 80.796875 -225.734375 C 80.796875 -223.085938 78.957031 -219.925781 75.28125 -216.25 C 71.601562 -212.582031 66.929688 -210.75 61.265625 -210.75 L 56.03125 -210.203125 L 50.96875 -210.203125 C 44.21875 -210.203125 38.972656 -211.796875 35.234375 -214.984375 C 31.503906 -218.179688 29.640625 -222.488281 29.640625 -227.90625 C 29.398438 -228.875 29.28125 -229.71875 29.28125 -230.4375 L 29.09375 -233.875 L 29.28125 -234.78125 C 29.28125 -235.382812 29.28125 -235.988281 29.28125 -236.59375 L 29.640625 -240.015625 C 29.640625 -245.566406 31.6875 -250.085938 35.78125 -253.578125 C 39.882812 -257.066406 46.03125 -258.8125 54.21875 -258.8125 Z M 44.28125 0.546875 C 29.820312 0.421875 22.59375 -5.179688 22.59375 -16.265625 C 22.59375 -21.566406 23.765625 -27.46875 26.109375 -33.96875 C 28.460938 -40.476562 30.148438 -46.265625 31.171875 -51.328125 C 32.203125 -56.390625 32.71875 -71.179688 32.71875 -95.703125 C 32.71875 -120.222656 32.320312 -134.019531 31.53125 -137.09375 C 30.75 -140.164062 28.789062 -144.410156 25.65625 -149.828125 C 22.53125 -155.253906 20.96875 -159.414062 20.96875 -162.3125 L 20.96875 -164.46875 C 20.96875 -170.375 22.894531 -174.257812 26.75 -176.125 C 30.601562 -178 37.171875 -178.9375 46.453125 -178.9375 L 54.046875 -179.46875 L 61.453125 -179.46875 C 70.242188 -179.46875 75.363281 -175.914062 76.8125 -168.8125 C 77.289062 -166.519531 77.53125 -156.335938 77.53125 -138.265625 L 77.53125 -99.59375 L 77.71875 -92 L 77.71875 -79.171875 L 78.078125 -71.75 C 78.203125 -70.0625 78.265625 -67.195312 78.265625 -63.15625 C 78.265625 -59.125 80.3125 -51.742188 84.40625 -41.015625 C 88.5 -30.296875 90.546875 -23.191406 90.546875 -19.703125 L 90.546875 -17.71875 C 90.546875 -5.539062 80.125 0.546875 59.28125 0.546875 Z M 44.28125 0.546875 "/></g></g><g transform="matrix(1, 0, 0, 1, 289, 634)"><g fill="currentColor" fill-opacity="1" transform="translate(7.742506, 346.409731)"><path d="M 194.453125 -3.0625 C 193.585938 7.625 183.425781 12.179688 163.96875 10.609375 C 158.082031 10.128906 152.148438 7.984375 146.171875 4.171875 C 140.203125 0.359375 136.5 -1.601562 135.0625 -1.71875 L 115.359375 4.125 C 104.828125 7.25 95.421875 8.472656 87.140625 7.796875 L 82.265625 7.40625 C 72.054688 6.582031 62.929688 3.578125 54.890625 -1.609375 C 46.847656 -6.796875 40.9375 -13.59375 37.15625 -22 C 31.613281 -34.175781 30.507812 -60.742188 33.84375 -101.703125 C 35.34375 -120.191406 35.9375 -131.257812 35.625 -134.90625 C 35.3125 -138.5625 34.265625 -143.546875 32.484375 -149.859375 C 30.703125 -156.171875 29.984375 -161.488281 30.328125 -165.8125 C 30.679688 -170.132812 32.625 -173.175781 36.15625 -174.9375 C 39.6875 -176.707031 45.597656 -177.257812 53.890625 -176.59375 L 58.75 -176.1875 C 70.757812 -175.21875 78.113281 -170.519531 80.8125 -162.09375 C 82.445312 -156.988281 81.878906 -137.382812 79.109375 -103.28125 C 76.335938 -69.175781 76.492188 -48.007812 79.578125 -39.78125 C 83.429688 -29.300781 91.546875 -23.5625 103.921875 -22.5625 C 110.296875 -22.039062 116.523438 -23.164062 122.609375 -25.9375 C 128.703125 -28.707031 133.347656 -32.679688 136.546875 -37.859375 C 141.679688 -46.023438 145.332031 -63.382812 147.5 -89.9375 C 148.488281 -102.1875 148.644531 -113.835938 147.96875 -124.890625 C 147.300781 -135.941406 147.144531 -143.6875 147.5 -148.125 C 148.570312 -161.332031 159.613281 -167.082031 180.625 -165.375 C 190.957031 -164.539062 196.640625 -160.09375 197.671875 -152.03125 C 197.972656 -149.707031 196.835938 -132.753906 194.265625 -101.171875 C 191.703125 -69.585938 190.847656 -48.625 191.703125 -38.28125 C 192.554688 -27.9375 193.304688 -20.472656 193.953125 -15.890625 C 194.609375 -11.304688 194.882812 -8.347656 194.78125 -7.015625 Z M 194.453125 -3.0625 "/></g></g><g transform="matrix(1, 0, 0, 1, 130, 642)"><g fill="currentColor" fill-opacity="1" transform="translate(25.201091, 359.634076)"><path d="M 102.828125 -3.765625 L 94.53125 -3.171875 C 84.320312 -2.460938 73.519531 -4.054688 62.125 -7.953125 C 29.820312 -19.109375 12.203125 -45.660156 9.265625 -87.609375 L 8.671875 -96.28125 C 8.640625 -96.632812 8.613281 -96.992188 8.59375 -97.359375 C 7.6875 -110.222656 9.066406 -122.394531 12.734375 -133.875 C 20.109375 -157.832031 35.25 -174.476562 58.15625 -183.8125 C 68.476562 -188.03125 81.210938 -190.664062 96.359375 -191.71875 C 111.503906 -192.78125 124.625 -190.863281 135.71875 -185.96875 C 146.8125 -181.070312 152.679688 -174.054688 153.328125 -164.921875 C 153.773438 -158.421875 152.550781 -153.441406 149.65625 -149.984375 C 146.769531 -146.523438 142.859375 -144.625 137.921875 -144.28125 C 132.992188 -143.9375 124.878906 -145.960938 113.578125 -150.359375 C 102.273438 -154.753906 94.335938 -156.789062 89.765625 -156.46875 C 76.421875 -155.53125 67.054688 -149.953125 61.671875 -139.734375 C 56.296875 -129.523438 54.28125 -114.773438 55.625 -95.484375 C 56.976562 -76.191406 62.242188 -61.789062 71.421875 -52.28125 C 80.609375 -42.78125 92.898438 -38.566406 108.296875 -39.640625 C 114.773438 -40.097656 122.25 -41.921875 130.71875 -45.109375 C 139.195312 -48.304688 145.476562 -50.046875 149.5625 -50.328125 C 158.21875 -50.941406 162.828125 -47.222656 163.390625 -39.171875 L 163.609375 -36.09375 C 164.035156 -29.96875 157.5 -23.289062 144 -16.0625 C 130.5 -8.832031 116.773438 -4.734375 102.828125 -3.765625 Z M 102.828125 -3.765625 "/></g></g><g transform="matrix(1, 0, 0, 1, 1069, 401)"><g fill="currentColor" fill-opacity="1" transform="translate(4.863697, 347.19428)"><path d="M 36.1875 -95.953125 C 26.332031 -105.734375 21.597656 -117.96875 21.984375 -132.65625 C 22.378906 -147.351562 28.851562 -159.539062 41.40625 -169.21875 C 53.957031 -178.894531 70.46875 -183.457031 90.9375 -182.90625 C 134.175781 -181.75 155.5625 -172.375 155.09375 -154.78125 C 154.9375 -148.875 153.671875 -144.148438 151.296875 -140.609375 C 148.785156 -136.929688 145.691406 -135.140625 142.015625 -135.234375 C 138.335938 -135.335938 130.753906 -138.101562 119.265625 -143.53125 C 107.785156 -148.96875 98.003906 -151.789062 89.921875 -152 C 81.847656 -152.21875 75.75 -150.664062 71.625 -147.34375 C 67.507812 -144.019531 65.398438 -140.492188 65.296875 -136.765625 C 65.117188 -129.890625 68.398438 -124.070312 75.140625 -119.3125 C 77.628906 -117.5625 88.023438 -113.097656 106.328125 -105.921875 C 124.640625 -98.742188 137.5625 -91.554688 145.09375 -84.359375 C 155.1875 -74.566406 160.035156 -62.257812 159.640625 -47.4375 C 159.242188 -32.625 153.992188 -20.71875 143.890625 -11.71875 C 130.171875 0.582031 113.492188 6.46875 93.859375 5.9375 L 88.984375 5.8125 C 66.816406 5.21875 50.363281 2.851562 39.625 -1.28125 C 25.070312 -6.863281 17.925781 -14.410156 18.1875 -23.921875 L 18.296875 -28.078125 C 18.441406 -33.734375 19.816406 -38.0625 22.421875 -41.0625 C 25.035156 -44.070312 27.304688 -45.550781 29.234375 -45.5 C 34.296875 -45.363281 43.035156 -42.054688 55.453125 -35.578125 C 67.878906 -29.097656 78.460938 -25.738281 87.203125 -25.5 C 95.941406 -25.269531 102.796875 -26.867188 107.765625 -30.296875 C 112.734375 -33.722656 115.300781 -38.660156 115.46875 -45.109375 C 115.644531 -51.554688 111.101562 -57.550781 101.84375 -63.09375 C 99.351562 -64.601562 89.460938 -68.78125 72.171875 -75.625 C 54.878906 -82.476562 42.882812 -89.253906 36.1875 -95.953125 Z M 36.1875 -95.953125 "/></g></g><g transform="matrix(1, 0, 0, 1, 1172, 653)"><g fill="currentColor" fill-opacity="1" transform="translate(4.449391, 347.655802)"><path d="M 36.1875 -95.953125 C 26.332031 -105.734375 21.597656 -117.96875 21.984375 -132.65625 C 22.378906 -147.351562 28.851562 -159.539062 41.40625 -169.21875 C 53.957031 -178.894531 70.46875 -183.457031 90.9375 -182.90625 C 134.175781 -181.75 155.5625 -172.375 155.09375 -154.78125 C 154.9375 -148.875 153.671875 -144.148438 151.296875 -140.609375 C 148.785156 -136.929688 145.691406 -135.140625 142.015625 -135.234375 C 138.335938 -135.335938 130.753906 -138.101562 119.265625 -143.53125 C 107.785156 -148.96875 98.003906 -151.789062 89.921875 -152 C 81.847656 -152.21875 75.75 -150.664062 71.625 -147.34375 C 67.507812 -144.019531 65.398438 -140.492188 65.296875 -136.765625 C 65.117188 -129.890625 68.398438 -124.070312 75.140625 -119.3125 C 77.628906 -117.5625 88.023438 -113.097656 106.328125 -105.921875 C 124.640625 -98.742188 137.5625 -91.554688 145.09375 -84.359375 C 155.1875 -74.566406 160.035156 -62.257812 159.640625 -47.4375 C 159.242188 -32.625 153.992188 -20.71875 143.890625 -11.71875 C 130.171875 0.582031 113.492188 6.46875 93.859375 5.9375 L 88.984375 5.8125 C 66.816406 5.21875 50.363281 2.851562 39.625 -1.28125 C 25.070312 -6.863281 17.925781 -14.410156 18.1875 -23.921875 L 18.296875 -28.078125 C 18.441406 -33.734375 19.816406 -38.0625 22.421875 -41.0625 C 25.035156 -44.070312 27.304688 -45.550781 29.234375 -45.5 C 34.296875 -45.363281 43.035156 -42.054688 55.453125 -35.578125 C 67.878906 -29.097656 78.460938 -25.738281 87.203125 -25.5 C 95.941406 -25.269531 102.796875 -26.867188 107.765625 -30.296875 C 112.734375 -33.722656 115.300781 -38.660156 115.46875 -45.109375 C 115.644531 -51.554688 111.101562 -57.550781 101.84375 -63.09375 C 99.351562 -64.601562 89.460938 -68.78125 72.171875 -75.625 C 54.878906 -82.476562 42.882812 -89.253906 36.1875 -95.953125 Z M 36.1875 -95.953125 "/></g></g><g transform="matrix(1, 0, 0, 1, 898, 420)"><g fill="currentColor" fill-opacity="1" transform="translate(5.651933, 347.127903)"><path d="M 139.484375 -111.6875 L 139.546875 -112.75 L 139.421875 -113.859375 L 139.53125 -115.84375 C 139.363281 -117.300781 139.296875 -118.332031 139.328125 -118.9375 C 139.703125 -125.914062 136.910156 -132.304688 130.953125 -138.109375 C 125.003906 -143.921875 118.363281 -147.03125 111.03125 -147.4375 L 105.625 -147.734375 C 95.507812 -148.285156 86.804688 -144.835938 79.515625 -137.390625 C 72.234375 -129.941406 68.332031 -121.40625 67.8125 -111.78125 L 67.65625 -108.890625 C 67.457031 -105.285156 69.707031 -103.359375 74.40625 -103.109375 L 78.890625 -102.3125 L 90.265625 -101.6875 L 91.15625 -101.828125 L 124.296875 -101.828125 L 128.09375 -102 C 135.3125 -101.601562 139.109375 -104.832031 139.484375 -111.6875 Z M 169.453125 -77.109375 C 159.253906 -73.679688 139.6875 -72.753906 110.75 -74.328125 C 81.8125 -75.898438 67.109375 -72.359375 66.640625 -63.703125 C 66.015625 -52.265625 69.914062 -43.054688 78.34375 -36.078125 C 86.769531 -29.109375 99.101562 -25.179688 115.34375 -24.296875 C 121.601562 -23.960938 129.628906 -25.09375 139.421875 -27.6875 C 149.222656 -30.289062 156.832031 -31.445312 162.25 -31.15625 C 168.863281 -30.789062 171.882812 -25.316406 171.3125 -14.734375 C 170.9375 -8.003906 163.332031 -1.96875 148.5 3.375 C 133.675781 8.726562 119.46875 11.035156 105.875 10.296875 L 101.71875 10.078125 C 86.914062 9.265625 74.015625 6.296875 63.015625 1.171875 C 52.015625 -3.941406 43.390625 -10.109375 37.140625 -17.328125 C 30.890625 -24.554688 25.941406 -34 22.296875 -45.65625 C 18.660156 -57.320312 17.222656 -70.132812 17.984375 -84.09375 L 18.21875 -88.40625 C 19.757812 -116.800781 28.140625 -138.789062 43.359375 -154.375 C 51.398438 -162.632812 61.203125 -168.769531 72.765625 -172.78125 C 84.328125 -176.800781 96.367188 -178.46875 108.890625 -177.78125 L 117.375 -177.3125 C 125.90625 -176.851562 134.710938 -174.6875 143.796875 -170.8125 C 161.367188 -163.34375 173.128906 -149.914062 179.078125 -130.53125 C 182.035156 -120.832031 183.285156 -111.769531 182.828125 -103.34375 L 182.609375 -99.390625 C 181.953125 -87.222656 177.566406 -79.796875 169.453125 -77.109375 Z M 169.453125 -77.109375 "/></g></g><g transform="matrix(1, 0, 0, 1, 779, 385)"><g fill="currentColor" fill-opacity="1" transform="translate(5.538007, 347.024832)"><path d="M 45.90625 -19.109375 C 39.882812 -30.648438 37.660156 -51.34375 39.234375 -81.1875 C 40.816406 -111.03125 40.785156 -129.847656 39.140625 -137.640625 C 38.273438 -141.921875 35 -146.203125 29.3125 -150.484375 C 23.632812 -154.765625 20.957031 -159.972656 21.28125 -166.109375 C 21.601562 -172.242188 23.695312 -176.476562 27.5625 -178.8125 C 28.4375 -179.375 30.910156 -180.597656 34.984375 -182.484375 C 39.066406 -184.378906 41.59375 -185.9375 42.5625 -187.15625 C 43.539062 -188.375 45.65625 -194.054688 48.90625 -204.203125 C 52.15625 -214.347656 55.300781 -221.359375 58.34375 -225.234375 C 61.382812 -229.117188 65.554688 -230.921875 70.859375 -230.640625 L 73.90625 -230.484375 C 80.78125 -230.117188 85.722656 -227.679688 88.734375 -223.171875 C 90.296875 -220.804688 91.738281 -215.054688 93.0625 -205.921875 C 94.382812 -196.796875 96.519531 -190.347656 99.46875 -186.578125 C 102.414062 -182.804688 108.78125 -179.363281 118.5625 -176.25 C 128.34375 -173.144531 133.082031 -168.707031 132.78125 -162.9375 C 132.476562 -157.164062 130.757812 -153.210938 127.625 -151.078125 C 124.5 -148.941406 118.492188 -147.144531 109.609375 -145.6875 C 100.722656 -144.226562 94.847656 -141.550781 91.984375 -137.65625 C 89.128906 -133.769531 87.21875 -122.679688 86.25 -104.390625 L 85.859375 -100.625 C 85.609375 -98.101562 85.394531 -95.15625 85.21875 -91.78125 L 84.65625 -81.125 C 83.476562 -58.863281 84.945312 -44.425781 89.0625 -37.8125 C 91.613281 -33.707031 97.453125 -30.71875 106.578125 -28.84375 C 115.710938 -26.96875 120.578125 -25.890625 121.171875 -25.609375 C 125.742188 -22.960938 127.882812 -18.9375 127.59375 -13.53125 L 127.453125 -10.625 C 127.191406 -5.695312 123.6875 -1.691406 116.9375 1.390625 C 110.195312 4.472656 102.019531 5.757812 92.40625 5.25 L 84.984375 4.859375 C 66.828125 3.898438 53.800781 -4.085938 45.90625 -19.109375 Z M 45.90625 -19.109375 "/></g></g><g transform="matrix(1, 0, 0, 1, 705, 398)"><g fill="currentColor" fill-opacity="1" transform="translate(12.063832, 351.36152)"><path d="M 45.375 -260.5 L 48.09375 -260.59375 C 64.34375 -261.144531 72.691406 -254.921875 73.140625 -241.921875 L 73.375 -235.0625 C 73.082031 -233.238281 72.976562 -231.003906 73.0625 -228.359375 C 73.15625 -225.710938 71.425781 -222.488281 67.875 -218.6875 C 64.320312 -214.894531 59.71875 -212.898438 54.0625 -212.703125 L 48.84375 -211.984375 L 43.78125 -211.8125 C 37.03125 -211.582031 31.734375 -213 27.890625 -216.0625 C 24.054688 -219.132812 22.046875 -223.378906 21.859375 -228.796875 C 21.585938 -229.742188 21.441406 -230.578125 21.421875 -231.296875 L 21.109375 -234.71875 L 21.265625 -235.640625 C 21.253906 -236.242188 21.238281 -236.847656 21.21875 -237.453125 L 21.453125 -240.890625 C 21.265625 -246.441406 23.15625 -251.023438 27.125 -254.640625 C 31.101562 -258.265625 37.1875 -260.21875 45.375 -260.5 Z M 44.265625 -0.953125 C 29.816406 -0.585938 22.40625 -5.941406 22.03125 -17.015625 C 21.84375 -22.316406 22.8125 -28.257812 24.9375 -34.84375 C 27.070312 -41.425781 28.566406 -47.265625 29.421875 -52.359375 C 30.273438 -57.453125 30.28125 -72.25 29.4375 -96.75 C 28.601562 -121.257812 27.738281 -135.035156 26.84375 -138.078125 C 25.957031 -141.128906 23.859375 -145.3125 20.546875 -150.625 C 17.234375 -155.9375 15.523438 -160.039062 15.421875 -162.9375 L 15.359375 -165.09375 C 15.148438 -171 16.941406 -174.945312 20.734375 -176.9375 C 24.523438 -178.9375 31.054688 -180.09375 40.328125 -180.40625 L 47.90625 -181.203125 L 55.3125 -181.453125 C 64.09375 -181.753906 69.328125 -178.378906 71.015625 -171.328125 C 71.578125 -169.054688 72.164062 -158.890625 72.78125 -140.828125 L 74.09375 -102.171875 L 74.546875 -94.59375 L 74.984375 -81.765625 L 75.59375 -74.359375 C 75.769531 -72.679688 75.925781 -69.828125 76.0625 -65.796875 C 76.207031 -61.765625 78.507812 -54.457031 82.96875 -43.875 C 87.425781 -33.289062 89.710938 -26.253906 89.828125 -22.765625 L 89.890625 -20.78125 C 90.304688 -8.613281 80.097656 -2.175781 59.265625 -1.46875 Z M 44.265625 -0.953125 "/></g></g><g transform="matrix(1, 0, 0, 1, 578, 409)"><g fill="currentColor" fill-opacity="1" transform="translate(6.778255, 346.640985)"><path d="M 46.125 -18.578125 C 40.226562 -30.179688 38.238281 -50.894531 40.15625 -80.71875 C 42.082031 -110.539062 42.273438 -129.363281 40.734375 -137.1875 C 39.921875 -141.46875 36.691406 -145.78125 31.046875 -150.125 C 25.410156 -154.476562 22.789062 -159.71875 23.1875 -165.84375 C 23.582031 -171.976562 25.734375 -176.1875 29.640625 -178.46875 C 30.515625 -179.019531 33.003906 -180.21875 37.109375 -182.0625 C 41.210938 -183.914062 43.753906 -185.441406 44.734375 -186.640625 C 45.710938 -187.847656 47.882812 -193.503906 51.25 -203.609375 C 54.625 -213.710938 57.851562 -220.6875 60.9375 -224.53125 C 64.03125 -228.382812 68.222656 -230.144531 73.515625 -229.8125 L 76.578125 -229.609375 C 83.429688 -229.171875 88.34375 -226.675781 91.3125 -222.125 C 92.84375 -219.738281 94.21875 -213.976562 95.4375 -204.84375 C 96.664062 -195.707031 98.722656 -189.234375 101.609375 -185.421875 C 104.503906 -181.609375 110.828125 -178.085938 120.578125 -174.859375 C 130.328125 -171.640625 135.015625 -167.144531 134.640625 -161.375 C 134.273438 -155.601562 132.515625 -151.671875 129.359375 -149.578125 C 126.210938 -147.484375 120.1875 -145.757812 111.28125 -144.40625 C 102.382812 -143.050781 96.484375 -140.445312 93.578125 -136.59375 C 90.671875 -132.738281 88.625 -121.671875 87.4375 -103.390625 L 87.015625 -99.625 C 86.734375 -97.09375 86.484375 -94.144531 86.265625 -90.78125 L 85.578125 -80.140625 C 84.140625 -57.890625 85.441406 -43.4375 89.484375 -36.78125 C 91.992188 -32.644531 97.800781 -29.585938 106.90625 -27.609375 C 116.019531 -25.640625 120.875 -24.507812 121.46875 -24.21875 C 126 -21.507812 128.085938 -17.453125 127.734375 -12.046875 L 127.546875 -9.15625 C 127.234375 -4.226562 123.691406 -0.265625 116.921875 2.734375 C 110.148438 5.742188 101.957031 6.9375 92.34375 6.3125 L 84.9375 5.84375 C 66.78125 4.664062 53.84375 -3.472656 46.125 -18.578125 Z M 46.125 -18.578125 "/></g></g><g transform="matrix(1, 0, 0, 1, 404, 395)"><g fill="currentColor" fill-opacity="1" transform="translate(34.467503, 364.834976)"><path d="M 120.921875 -131.546875 L 120.8125 -132.625 L 120.53125 -133.703125 L 120.34375 -135.671875 C 119.945312 -137.085938 119.71875 -138.097656 119.65625 -138.703125 C 118.976562 -145.660156 115.253906 -151.554688 108.484375 -156.390625 C 101.710938 -161.234375 94.671875 -163.296875 87.359375 -162.578125 L 81.96875 -162.0625 C 71.894531 -161.070312 63.820312 -156.34375 57.75 -147.875 C 51.675781 -139.40625 49.113281 -130.378906 50.0625 -120.796875 L 50.34375 -117.90625 C 50.695312 -114.3125 53.21875 -112.742188 57.90625 -113.203125 L 62.4375 -113.09375 L 73.78125 -114.203125 L 74.65625 -114.484375 L 107.40625 -119.515625 L 111.125 -120.265625 C 118.320312 -120.960938 121.585938 -124.722656 120.921875 -131.546875 Z M 155.796875 -101.921875 C 146.234375 -96.992188 127.03125 -93.113281 98.1875 -90.28125 C 69.351562 -87.445312 55.359375 -81.710938 56.203125 -73.078125 C 57.328125 -61.691406 62.582031 -53.191406 71.96875 -47.578125 C 81.351562 -41.960938 94.140625 -39.945312 110.328125 -41.53125 C 116.566406 -42.144531 124.328125 -44.476562 133.609375 -48.53125 C 142.898438 -52.59375 150.242188 -54.890625 155.640625 -55.421875 C 162.234375 -56.066406 166.050781 -51.113281 167.09375 -40.5625 C 167.75 -33.851562 161.148438 -26.726562 147.296875 -19.1875 C 133.453125 -11.65625 119.753906 -7.222656 106.203125 -5.890625 L 102.078125 -5.484375 C 87.316406 -4.035156 74.109375 -5.003906 62.453125 -8.390625 C 50.804688 -11.785156 41.347656 -16.578125 34.078125 -22.765625 C 26.816406 -28.960938 20.5 -37.546875 15.125 -48.515625 C 9.75 -59.492188 6.375 -71.941406 5 -85.859375 L 4.578125 -90.171875 C 1.796875 -118.460938 6.742188 -141.460938 19.421875 -159.171875 C 26.117188 -168.546875 34.875 -176.097656 45.6875 -181.828125 C 56.507812 -187.554688 68.160156 -191.035156 80.640625 -192.265625 L 89.09375 -193.09375 C 97.601562 -193.925781 106.644531 -193.113281 116.21875 -190.65625 C 134.707031 -185.9375 148.363281 -174.445312 157.1875 -156.1875 C 161.59375 -147.050781 164.207031 -138.285156 165.03125 -129.890625 L 165.421875 -125.9375 C 166.609375 -113.820312 163.398438 -105.816406 155.796875 -101.921875 Z M 155.796875 -101.921875 "/></g></g><g transform="matrix(1, 0, 0, 1, 240, 361)"><g fill="currentColor" fill-opacity="1" transform="translate(1.198094, 347.449817)"><path d="M 148.203125 -84.40625 L 148.203125 -94.171875 C 148.203125 -112.117188 145.3125 -125.613281 139.53125 -134.65625 C 132.0625 -146.21875 122.363281 -152 110.4375 -152 L 107 -152 C 94.582031 -152 85.304688 -147.359375 79.171875 -138.078125 C 74.460938 -130.972656 72.109375 -117.238281 72.109375 -96.875 L 72.109375 -77.359375 L 72.296875 -75.546875 L 72.84375 -63.4375 C 72.957031 -62.226562 73.015625 -61.082031 73.015625 -60 C 73.015625 -50.238281 75.753906 -42.40625 81.234375 -36.5 C 86.722656 -30.601562 93.984375 -27.65625 103.015625 -27.65625 L 108.078125 -27.65625 C 120.128906 -27.65625 129.828125 -32.804688 137.171875 -43.109375 C 144.523438 -53.410156 148.203125 -67.175781 148.203125 -84.40625 Z M 43.5625 75.546875 C 28.019531 75.546875 20.25 70.304688 20.25 59.828125 L 20.25 56.03125 C 20.25 53.375 21.332031 47.890625 23.5 39.578125 C 25.664062 31.265625 27.019531 20.601562 27.5625 7.59375 C 28.101562 -5.414062 28.375 -22.890625 28.375 -44.828125 L 28.375 -103.75 L 28.203125 -116.765625 C 28.203125 -132.066406 26.875 -143.421875 24.21875 -150.828125 C 21.570312 -158.234375 20.25 -163.742188 20.25 -167.359375 C 20.25 -174.472656 29.582031 -178.03125 48.25 -178.03125 C 48.613281 -178.03125 48.914062 -178.03125 49.15625 -178.03125 C 51.8125 -178.03125 55.664062 -177.15625 60.71875 -175.40625 C 65.78125 -173.65625 70.875 -172.78125 76 -172.78125 C 81.125 -172.78125 88.265625 -174.40625 97.421875 -177.65625 C 106.578125 -180.914062 115.375 -182.546875 123.8125 -182.546875 L 128.140625 -182.546875 C 147.421875 -182.546875 163.390625 -174.894531 176.046875 -159.59375 C 188.578125 -144.289062 194.84375 -123.804688 194.84375 -98.140625 L 194.84375 -93.4375 C 194.84375 -81.144531 192.820312 -68.492188 188.78125 -55.484375 C 184.75 -42.472656 178.484375 -31.597656 169.984375 -22.859375 C 161.492188 -14.128906 152.394531 -8.101562 142.6875 -4.78125 C 132.988281 -1.46875 121.691406 0.1875 108.796875 0.1875 C 95.910156 0.1875 86.695312 2.050781 81.15625 5.78125 C 78.5 7.59375 77.171875 10.664062 77.171875 15 C 77.171875 19.34375 77.984375 25.273438 79.609375 32.796875 C 81.242188 40.328125 82.0625 46.984375 82.0625 52.765625 C 82.0625 58.554688 79.015625 63.800781 72.921875 68.5 C 66.835938 73.195312 59.820312 75.546875 51.875 75.546875 Z M 43.5625 75.546875 "/></g></g></svg>`;

const ICON_BABY_SILHOUETTE = `<svg viewBox="0 0 100 100" width="70%" height="70%" fill="currentColor"><circle cx="50" cy="32" r="17"/><path d="M28 58 Q50 47 72 58 L75 86 Q50 97 25 86 Z"/></svg>`;
const ICON_STATS = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M6 15l4-4 3 3 6-7"/><path d="M15 6h4v4"/></svg>`;
const ICON_REACT_AIME = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>`;
const ICON_REACT_MITIGE = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><line x1="8" y1="15" x2="16" y2="15"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>`;
const ICON_REACT_ALLERGIE = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l10 18H2L12 3z"/><line x1="12" y1="10" x2="12" y2="14"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;
const ICON_USERS = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`;
const ICON_GOOGLE = `<svg viewBox="0 0 48 48" width="20" height="20"><path fill="#FFC107" d="M43.6 20.5H42V20.4H24v7.2h11.3c-1.6 4.6-6 7.9-11.3 7.9-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.1-5.1C33.5 6.1 29 4.4 24 4.4 13.3 4.4 4.6 13.1 4.6 23.8s8.7 19.4 19.4 19.4S43.4 34.5 43.4 23.8c0-1.1-.1-2.3-.3-3.3z"/><path fill="#FF3D00" d="M6.3 14.7l5.9 4.3c1.6-4 5.5-6.8 10-6.8 3.1 0 5.9 1.2 8 3.1l5.1-5.1C33.5 6.1 29 4.4 24 4.4c-7.5 0-14 4.2-17.7 10.3z"/><path fill="#4CAF50" d="M24 43.2c4.9 0 9.4-1.9 12.8-4.9l-5.9-5c-1.9 1.4-4.3 2.2-6.9 2.2-5.3 0-9.7-3.3-11.3-7.9l-5.9 4.6c3.7 6.2 10.2 11 17.2 11z"/><path fill="#1976D2" d="M43.6 20.5H42V20.4H24v7.2h11.3c-.8 2.2-2.2 4.1-4.1 5.4l5.9 5c-.4.4 6.3-4.6 6.3-14.2 0-1.1-.1-2.3-.3-3.3z"/></svg>`;

function renderMain(){
  autoMigratePastMeals();
  const todayLabel = new Date().toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
  const tabTitles = { planning: 'Planning', historique: 'Historique', stats: 'Statistiques', partage: 'Paramètres', profil: 'Profil de bébé' };
  const headerPhotoStyle = planningData.photo ? `background-image:url('${escapeHtml(planningData.photo)}');background-size:cover;background-position:center;` : '';
  return `
    <div class="top-header">
      <div style="display:flex;align-items:center;gap:12px;">
        <button class="avatar" id="avatar-btn" data-tab="profil" aria-label="Voir le profil de bébé" style="border:none;cursor:pointer;padding:0;overflow:hidden;color:var(--accent);${headerPhotoStyle || 'background:var(--accent-light);'}">${planningData.photo ? '' : ICON_BABY_SILHOUETTE}</button>
        <div>
          <div style="font-size:12px;color:var(--primary-text);font-weight:500;">${todayLabel}</div>
          <div style="font-weight:700;font-size:20px;color:var(--text);">${escapeHtml(planningData.babyName)}</div>
        </div>
      </div>
      <div style="display:flex;gap:8px;">
        <button class="header-icon-btn ${state.tab==='stats'?'active':''}" data-tab="stats" aria-label="Stats">${ICON_STATS}</button>
        <button class="header-icon-btn" id="switch-baby-btn" aria-label="Changer de bébé">${ICON_USERS}</button>
        <button class="header-icon-btn ${state.tab==='partage'?'active':''}" data-tab="partage" aria-label="Paramètres">${ICON_SETTINGS}</button>
      </div>
    </div>
    <div style="padding:0 1.25rem;">
      <div class="title-font" style="font-size:30px;color:var(--text);margin-top:10px;margin-bottom:14px;text-align:center;">${tabTitles[state.tab]}</div>
    </div>
    <div class="screen" style="padding-bottom:1rem;padding-top:0.5rem;">
      ${state.tab === 'planning' ? renderPlanningTab() : ''}
      ${state.tab === 'historique' ? renderHistoriqueTab() : ''}
      ${state.tab === 'stats' ? renderStatsTab() : ''}
      ${state.tab === 'partage' ? renderPartageTab() : ''}
      ${state.tab === 'profil' ? renderProfilTab() : ''}
    </div>
    <div class="tabbar">
      <button class="tab ${state.tab==='planning'?'active':''}" data-tab="planning">${ICON_CALENDAR}<span>Planning</span></button>
      ${state.role === 'edit' ? `<button class="tab-add-btn" id="fab-add" aria-label="Ajouter un repas">${ICON_PLUS}</button>` : `<span class="tab-spacer"></span>`}
      <button class="tab ${state.tab==='historique'?'active':''}" data-tab="historique">${ICON_HISTORY}<span>Historique</span></button>
    </div>
    ${state.showModal ? renderAddModal() : ''}
    ${state.showBabySwitcher ? renderBabySwitcherModal() : ''}
  `;
}

function renderBabySwitcherModal(){
  const rows = state.knownPlannings.map(p => {
    const isCurrent = p.planningId === state.planningId;
    const avatarStyle = p.photo ? `background-image:url('${p.photo}');background-size:cover;background-position:center;` : 'background:var(--accent-light);';
    return `
    <div class="card" style="display:flex;align-items:center;justify-content:space-between;">
      <div style="display:flex;align-items:center;gap:12px;min-width:0;">
        <span class="avatar" style="width:44px;height:44px;flex-shrink:0;color:var(--accent);${avatarStyle}">${p.photo ? '' : ICON_BABY_SILHOUETTE}</span>
        <div style="min-width:0;">
          <div style="font-weight:600;font-size:16px;">${escapeHtml(p.babyName) || 'Bébé'}</div>
          <div style="font-size:16px;color:var(--text-secondary);">${p.role === 'edit' ? 'Administrateur' : 'Lecture seule'}${isCurrent ? ' · Actuel' : ''}</div>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
        ${!isCurrent ? `<button class="btn btn-secondary" data-switchid="${p.planningId}" data-switchrole="${p.role}" style="height:36px;font-size:16px;padding:0 12px;">Basculer</button>` : ''}
        <button class="header-icon-btn" data-forgetid="${p.planningId}" aria-label="Oublier ce bébé" style="opacity:0.7;">${ICON_TRASH}</button>
      </div>
    </div>`;
  }).join('');
  return `
    <div class="modal-overlay" id="baby-switcher-overlay">
      <div class="modal-sheet">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;">
          <h2 style="font-size:30px;">Mes bébés</h2>
          <button id="close-baby-switcher" class="modal-close-btn" aria-label="Fermer" style="background:none;border:none;font-size:18px;color:var(--text-secondary);">✕</button>
        </div>
        ${rows || `<p style="color:var(--text-muted);font-size:16px;">Aucun autre bébé accessible avec ce compte.</p>`}
        <button class="btn btn-secondary" id="add-baby-btn" style="margin-top:1rem;">+ Ajouter un autre bébé</button>
      </div>
    </div>
  `;
}

function renderPlanningTab(){
  const futurs = planningData.meals.filter(m => m.statut === 'futur').sort((a,b)=> (a.date+a.heure).localeCompare(b.date+b.heure));
  if(futurs.length === 0){
    return `<p style="text-align:center;color:var(--text-muted);font-size:16px;margin-top:2rem;">Aucun repas planifié pour l'instant.</p>`;
  }
  return futurs.map(m => {
    return `
    <div class="card" style="display:flex;align-items:center;gap:12px;">
      <div style="flex:1;min-width:0;">
        <div style="font-size:16px;font-style:italic;color:var(--text-secondary);">${fmtDate(m.date)}, ${escapeHtml(m.heure)}</div>
        <div style="font-weight:600;font-size:16px;margin-top:4px;">${escapeHtml(m.moment)}</div>
        <div style="font-size:16px;color:var(--text-secondary);margin-top:2px;">${escapeHtml(m.aliments)}</div>
      </div>
      ${state.role === 'edit' ? `<button class="edit-meal-btn" data-editid="${m.id}" style="background:none;border:none;font-size:16px;color:var(--text-secondary);text-decoration:underline;white-space:nowrap;padding:0;flex-shrink:0;">Modifier</button>` : ''}
    </div>
  `}).join('');
}

function renderHistoriqueTab(){
  const passes = planningData.meals.filter(m => m.statut === 'passe').sort((a,b)=> (b.date+b.heure).localeCompare(a.date+a.heure));
  if(passes.length === 0){
    return `<p style="text-align:center;color:var(--text-muted);font-size:16px;margin-top:2rem;">Aucun repas enregistré pour l'instant.</p>`;
  }
  return passes.map(m => {
    const foods = getMealFoods(m);
    const reactions = getMealReactions(m);
    return `
    <div class="card">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:2px;">
        <div>
          <div style="font-size:16px;font-style:italic;color:var(--text-secondary);">${fmtDate(m.date)}, ${m.heure}</div>
          <div style="font-weight:600;font-size:16px;margin-top:4px;">${m.moment}</div>
        </div>
        ${state.role === 'edit' ? `<button class="edit-meal-btn" data-editid="${m.id}" style="background:none;border:none;font-size:16px;color:var(--text-secondary);text-decoration:underline;white-space:nowrap;padding:0;display:flex;align-items:center;">Modifier</button>` : ''}
      </div>
      ${foods.map((food, i) => {
        const r = reactions[food];
        return `
          <div style="margin-bottom:${i < foods.length - 1 ? '12px' : '0'};">
            <div style="font-size:16px;color:var(--text-secondary);margin-bottom:6px;">${escapeHtml(food)}</div>
            <div class="react-row">
              <button class="react-btn" data-react="aime" data-id="${m.id}" data-food="${escapeHtml(food)}" aria-label="Aimé" style="${r==='aime' ? `border-color:var(--success-text);background:var(--success-bg);color:var(--success-text);` : ''}">${ICON_REACT_AIME}</button>
              <button class="react-btn" data-react="mitige" data-id="${m.id}" data-food="${escapeHtml(food)}" aria-label="Mitigé" style="${r==='mitige' ? `border-color:var(--warning-text);background:var(--warning-bg);color:var(--warning-text);` : ''}">${ICON_REACT_MITIGE}</button>
              <button class="react-btn" data-react="allergie" data-id="${m.id}" data-food="${escapeHtml(food)}" aria-label="Allergie suspectée" style="${r==='allergie' ? `border-color:var(--danger-text);background:var(--danger-bg);color:var(--danger-text);` : ''}">${ICON_REACT_ALLERGIE}</button>
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `}).join('');
}

function renderStatsTab(){
  const passes = planningData.meals.filter(m => m.statut === 'passe');
  const groupSets = { aime: new Set(), mitige: new Set(), allergie: new Set() };
  passes.forEach(m => {
    const reactions = getMealReactions(m);
    getMealFoods(m).forEach(food => {
      const r = reactions[food];
      if(r && groupSets[r]) groupSets[r].add(food);
    });
  });
  const groups = {
    aime: Array.from(groupSets.aime).map(f => ({ aliments: f })),
    mitige: Array.from(groupSets.mitige).map(f => ({ aliments: f })),
    allergie: Array.from(groupSets.allergie).map(f => ({ aliments: f }))
  };

  const reactionCardsHtml = ['aime','mitige','allergie'].map(key => {
    const rc = reactionConfig(key);
    const list = groups[key];
    const isOpen = state.statsExpanded === key;
    return `
      <button class="card stats-reaction-row" data-statskey="${key}" style="width:100%;text-align:left;border:none;cursor:pointer;display:block;background:${rc.bg};">
        <div style="display:flex;align-items:center;justify-content:space-between;">
          <span style="display:flex;align-items:center;gap:10px;">
            <span style="color:${rc.text};display:flex;align-items:center;">${rc.icon}</span>
            <span style="font-size:16px;font-weight:700;color:${rc.text};">${rc.label}</span>
          </span>
          <span style="font-size:16px;color:${rc.text};">${list.length} aliment${list.length > 1 ? 's' : ''}</span>
        </div>
        ${isOpen ? (list.length ? `<div style="margin-top:10px;display:flex;flex-wrap:wrap;gap:6px;">${list.map(m => `<span style="font-size:16px;background:var(--card);color:${rc.text};padding:4px 10px;border-radius:20px;">${escapeHtml(m.aliments)}</span>`).join('')}</div>` : `<p style="font-size:16px;color:${rc.text};opacity:0.8;margin:10px 0 0;">Aucun aliment pour l'instant.</p>`) : ''}
      </button>
    `;
  }).join('');

  const categories = ['Légume','Fruit','Féculent','Viande','Poisson','Herbe','Épice','Autre'];
  const catRowsHtml = categories.map(c => {
    const catValue = c + 's';
    const uniqueFoods = new Set();
    passes.forEach(m => {
      getMealFoods(m).forEach(food => {
        if(getCategoryForAliment(food) === catValue) uniqueFoods.add(food);
      });
    });
    const foods = Array.from(uniqueFoods);
    const n = foods.length;
    const label = n > 1 ? catValue : c;
    const isOpen = state.statsExpandedCategory === catValue;
    return `
      <button class="card stats-category-row" data-catkey="${catValue}" style="width:100%;text-align:left;border:none;cursor:pointer;display:block;">
        <div style="display:flex;align-items:center;justify-content:space-between;">
          <span style="font-size:16px;font-weight:600;color:var(--text);">${label}</span>
          <span style="font-size:16px;color:var(--text-secondary);">${n}</span>
        </div>
        ${isOpen ? (n ? `<p style="font-size:16px;color:var(--text-secondary);margin:10px 0 0;">${foods.map(escapeHtml).join(', ')}</p>` : `<p style="font-size:16px;color:var(--text-muted);margin:10px 0 0;">Aucun aliment pour l'instant.</p>`) : ''}
      </button>
    `;
  }).join('');

  return `
    <p style="font-size:16px;color:var(--text-secondary);margin:0 0 0.75rem;font-weight:600;">Réactions de bébé</p>
    ${reactionCardsHtml}
    <p style="font-size:16px;color:var(--text-secondary);margin:1.25rem 0 0.75rem;font-weight:600;">Aliments essayés par catégorie</p>
    ${catRowsHtml}
  `;
}

function renderProfilTab(){
  const canEdit = state.role === 'edit';
  const birthdateLabel = planningData.birthdate
    ? new Date(planningData.birthdate).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })
    : 'Non renseignée';
  const genderLabel = planningData.gender === 'fille' ? '♀ Fille' : planningData.gender === 'garcon' ? '♂ Garçon' : 'Non renseigné';
  const photoStyle = planningData.photo ? `background-image:url('${escapeHtml(planningData.photo)}');background-size:cover;background-position:center;` : '';
  return `
    <div style="display:flex;flex-direction:column;align-items:center;margin-bottom:1.75rem;">
      <button id="photo-btn" class="avatar" aria-label="Changer la photo de bébé" ${canEdit ? '' : 'disabled'} style="width:130px;height:130px;font-size:52px;border:none;cursor:${canEdit ? 'pointer' : 'default'};overflow:hidden;display:flex;align-items:center;justify-content:center;color:var(--accent);${photoStyle || 'background:var(--accent-light);'}">${planningData.photo ? '' : ICON_BABY_SILHOUETTE}</button>
      <input type="file" id="photo-input" accept="image/*" style="display:none;" />
      ${canEdit ? `<div style="font-size:16px;color:var(--text-muted);margin-top:10px;">Touche la photo pour la changer</div>` : ''}
    </div>
    <div class="card" style="display:flex;justify-content:space-between;align-items:center;">
      <div>
        <div style="font-size:16px;color:var(--text-secondary);margin-bottom:4px;">Prénom</div>
        <div style="font-size:16px;font-weight:600;color:var(--text);">${escapeHtml(planningData.babyName)}</div>
      </div>
      ${canEdit ? `<button class="edit-field-btn" data-field="name" aria-label="Modifier le prénom">${ICON_EDIT}</button>` : ''}
    </div>
    <div class="card" style="display:flex;justify-content:space-between;align-items:center;">
      <div>
        <div style="font-size:16px;color:var(--text-secondary);margin-bottom:4px;">Date de naissance</div>
        <div style="font-size:16px;font-weight:600;color:var(--text);">${birthdateLabel}</div>
      </div>
      ${canEdit ? `<button class="edit-field-btn" data-field="birthdate" aria-label="Modifier la date de naissance">${ICON_EDIT}</button>` : ''}
    </div>
    <div class="card" style="display:flex;justify-content:space-between;align-items:center;">
      <div>
        <div style="font-size:16px;color:var(--text-secondary);margin-bottom:4px;">Sexe</div>
        <div style="font-size:16px;font-weight:600;color:var(--text);">${genderLabel}</div>
      </div>
      ${canEdit ? `<button class="edit-field-btn" data-field="gender" aria-label="Modifier le sexe">${ICON_EDIT}</button>` : ''}
    </div>
    ${state.editingField ? renderProfileEditModal() : ''}
  `;
}

function renderProfileEditModal(){
  const field = state.editingField;
  let inner = '';
  if(field === 'name'){
    inner = `
      <div class="field">
        <label>Prénom</label>
        <input type="text" id="edit-name-input" value="${escapeHtml(planningData.babyName)}" />
        <p class="error-text" id="edit-name-error" style="display:none;">Indique un prénom</p>
      </div>`;
  } else if(field === 'birthdate'){
    const minDate = new Date();
    minDate.setFullYear(minDate.getFullYear() - 100);
    inner = `
      <div class="field">
        <label>Date de naissance</label>
        <input type="date" id="edit-birthdate-input" value="${planningData.birthdate || ''}" min="${localDateStr(minDate)}" max="${localDateStr(new Date())}" />
        <p class="error-text" id="edit-birthdate-error" style="display:none;">Erreur de date</p>
      </div>`;
  } else if(field === 'gender'){
    inner = `
      <div class="field">
        <label>Sexe</label>
        <div class="gender-toggle">
          <button type="button" class="gender-btn ${editGenderTemp === 'fille' ? 'selected' : ''}" id="edit-gender-fille" data-val="fille">♀ Fille</button>
          <button type="button" class="gender-btn ${editGenderTemp === 'garcon' ? 'selected' : ''}" id="edit-gender-garcon" data-val="garcon">♂ Garçon</button>
        </div>
      </div>`;
  }
  return `
    <div class="modal-overlay" id="profile-modal-overlay">
      <div class="modal-sheet">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;">
          <h2 style="font-size:30px;">Modifier</h2>
          <button id="close-profile-modal" class="modal-close-btn" aria-label="Fermer" style="background:none;border:none;font-size:18px;color:var(--text-secondary);">✕</button>
        </div>
        ${inner}
        <button class="btn btn-primary" id="save-profile-field" style="margin-top:0.5rem;">Enregistrer</button>
      </div>
    </div>
  `;
}

let planningMembers = [];
let planningMembersForId = null;

async function loadPlanningMembersIfNeeded(){
  if(state.tab !== 'partage' || !state.planningId || state.role !== 'edit') return;
  if(planningMembersForId === state.planningId) return;
  planningMembersForId = state.planningId;
  planningMembers = await listPlanningMembers(state.planningId);
  render();
}

function renderPartageTab(){
  const myPseudo = (state.userProfile && state.userProfile.pseudo) || '';
  const myIdentifier = (state.userProfile && (state.userProfile.phone || state.userProfile.email)) || 'Compte connecté';
  const pseudoSection = `
    <div class="card" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
      <div style="min-width:0;">
        <div style="font-size:16px;color:var(--text-secondary);margin-bottom:4px;">Ton nom affiché</div>
        <div style="font-size:16px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(myPseudo) || '—'}</div>
      </div>
      <button class="edit-field-btn" id="edit-pseudo-btn" aria-label="Modifier ton nom">${ICON_EDIT}</button>
    </div>
    <div class="card" style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:1.5rem;">
      <div style="min-width:0;">
        <div style="font-size:16px;color:var(--text-secondary);margin-bottom:4px;">Connecté avec</div>
        <div style="font-size:15px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(myIdentifier)}</div>
      </div>
      <button class="btn btn-secondary" id="logout-btn" style="width:auto;height:38px;padding:0 14px;font-size:15px;flex-shrink:0;">Déconnexion</button>
    </div>
    ${state.editingPseudo ? renderPseudoEditModal() : ''}
  `;
  const legalLinks = `<p style="text-align:center;font-size:13px;color:var(--text-muted);margin-top:2rem;"><a href="./cgu.html" style="color:var(--text-muted);">CGU</a> · <a href="./confidentialite.html" style="color:var(--text-muted);">Confidentialité</a></p>`;

  if(state.role !== 'edit'){
    return pseudoSection + `<p style="text-align:center;color:var(--text-muted);font-size:16px;margin-top:2rem;">Seul un administrateur peut gérer les accès de ce planning.</p>` + legalLinks;
  }
  const myUid = auth.currentUser && auth.currentUser.uid;
  const membersHtml = planningMembersForId === state.planningId
    ? (planningMembers.length ? planningMembers.map(m => `
        <div class="card" style="display:flex;align-items:center;justify-content:space-between;">
          <div style="min-width:0;">
            <div style="font-weight:600;font-size:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(m.pseudo || m.identifier) || 'Compte'}${m.uid === myUid ? ' (toi)' : ''}</div>
            <div style="font-size:14px;color:var(--text-secondary);">${m.role === 'edit' ? 'Administrateur' : 'Lecture seule'}</div>
          </div>
          ${m.uid !== myUid ? `<button class="header-icon-btn" data-revokeuid="${m.uid}" aria-label="Retirer l'accès" style="opacity:0.7;flex-shrink:0;">${ICON_TRASH}</button>` : ''}
        </div>
      `).join('') : `<p style="color:var(--text-muted);font-size:15px;">Personne d'autre pour l'instant.</p>`)
    : `<p style="color:var(--text-muted);font-size:15px;">Chargement...</p>`;

  return pseudoSection + `
    <p style="font-size:16px;color:var(--text-secondary);margin:0 0 1.25rem;">Donne accès à quelqu'un via son email ou son numéro de téléphone. Si elle n'a pas encore de compte, l'accès sera donné automatiquement dès son inscription.</p>

    <div class="card">
      <label style="display:block;margin-bottom:10px;">Donner un accès</label>

      <div style="display:flex;gap:8px;margin-bottom:12px;">
        <button class="btn ${state.inviteRole === 'edit' ? 'btn-primary' : 'btn-secondary'}" data-inviterole="edit" style="height:38px;font-size:15px;${state.inviteRole === 'edit' ? 'color:#FFFFFF;' : ''}">Administrateur</button>
        <button class="btn ${state.inviteRole === 'view' ? 'btn-primary' : 'btn-secondary'}" data-inviterole="view" style="height:38px;font-size:15px;${state.inviteRole === 'view' ? 'color:#FFFFFF;' : ''}">Lecture seule</button>
      </div>

      <input type="text" id="grant-identifier-input" placeholder="Email ou numéro de téléphone" style="margin-bottom:10px;" autocapitalize="none" />
      ${state.grantError ? `<p class="error-text" style="margin-bottom:10px;">${state.grantError}</p>` : ''}
      ${state.grantSuccessMessage ? `<p style="color:var(--success-text);background:var(--success-bg);border-radius:12px;padding:10px 14px;font-size:15px;margin-bottom:10px;">${state.grantSuccessMessage}</p>` : ''}
      <button class="btn btn-primary" id="grant-access-btn" style="color:#FFFFFF;" ${state.grantBusy ? 'disabled' : ''}>${state.grantBusy ? 'Envoi en cours...' : "Donner l'accès"}</button>
    </div>

    <label style="display:block;margin:1.5rem 0 10px;">Personnes ayant accès</label>
    ${membersHtml}
  ` + legalLinks;
}

function renderPseudoEditModal(){
  const current = (state.userProfile && state.userProfile.pseudo) || '';
  return `
    <div class="modal-overlay" id="pseudo-edit-overlay">
      <div class="modal-sheet">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;">
          <h2 style="font-size:30px;">Modifier</h2>
          <button id="close-pseudo-edit" class="modal-close-btn" aria-label="Fermer" style="background:none;border:none;font-size:18px;color:var(--text-secondary);">✕</button>
        </div>
        <div class="field">
          <label>Ton nom affiché</label>
          <input type="text" id="edit-pseudo-input" value="${escapeHtml(current)}" placeholder="Ex : Maman, Léo, Mamie..." />
          <p class="error-text" id="edit-pseudo-error" style="display:none;">Indique un nom</p>
        </div>
        <button class="btn btn-primary" id="save-pseudo-btn" style="margin-top:0.5rem;">Enregistrer</button>
      </div>
    </div>
  `;
}

function renderAddModal(){
  const isEditing = !!editingMealId;
  return `
    <div class="modal-overlay" id="modal-overlay">
      <div class="modal-sheet" id="modal-sheet">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;">
          <h2 style="font-size:30px;">${isEditing ? 'Modifier le repas' : 'Ajouter un repas'}</h2>
          <button id="close-modal" class="modal-close-btn" aria-label="Fermer" style="background:none;border:none;font-size:18px;color:var(--text-secondary);">✕</button>
        </div>
        <div class="field">
          <label>Moment du repas</label>
          <select id="moment-input">
            <option>Petit-déjeuner</option>
            <option>Déjeuner</option>
            <option>Goûter</option>
            <option>Dîner</option>
          </select>
        </div>
        <div style="display:flex;gap:10px;">
          <div class="field" style="flex:1;">
            <label>Date</label>
            <input type="date" id="date-input" />
            <p class="error-text" id="date-error" style="display:none;">Indique une date</p>
          </div>
          <div class="field" style="flex:1;">
            <label>Heure</label>
            <input type="time" id="heure-input" value="12:00" />
          </div>
        </div>
        <div class="field">
          <label>Aliments</label>
          <div id="aliment-chips" style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:${modalAliments.length ? '10px' : '0'};">
            ${modalAliments.map((a, i) => `
              <span style="display:inline-flex;align-items:center;gap:8px;font-size:16px;font-weight:700;background:var(--primary-light);color:var(--primary-text);border:1.5px solid var(--primary);padding:6px 8px 6px 14px;border-radius:20px;">
                ${escapeHtml(a)}
                <button type="button" class="chip-remove-btn" data-idx="${i}" aria-label="Retirer ${escapeHtml(a)}" style="background:var(--primary);border:none;color:var(--card);width:20px;height:20px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:16px;cursor:pointer;">✕</button>
              </span>
            `).join('')}
          </div>
          <div style="position:relative;">
            <input type="text" id="aliment-search-input" placeholder="Rechercher un aliment (ex : fraise)" autocomplete="off" />
            <div id="aliment-suggestions" style="display:none;position:absolute;top:calc(100% + 4px);left:0;right:0;background:var(--card);border:1.5px solid var(--border);border-radius:12px;max-height:220px;overflow-y:auto;z-index:5;"></div>
          </div>
          <div id="category-picker" style="display:none;margin-top:10px;padding:14px;background:var(--primary-light);border-radius:12px;">
            <div style="font-size:15px;color:var(--text-secondary);margin-bottom:8px;">Dans quelle catégorie classer <strong id="category-picker-food" style="color:var(--text);"></strong> ?</div>
            <select id="category-picker-select" style="margin-bottom:10px;">
              <option value="Légumes">Légumes</option>
              <option value="Fruits">Fruits</option>
              <option value="Féculents">Féculents</option>
              <option value="Viandes">Viandes</option>
              <option value="Poissons">Poissons</option>
              <option value="Herbes">Herbes</option>
              <option value="Épices">Épices</option>
              <option value="Autres" selected>Autres</option>
            </select>
            <button type="button" id="category-picker-confirm" class="btn btn-primary" style="height:38px;font-size:15px;color:#FFFFFF;">Ajouter cet aliment</button>
          </div>
          <p class="error-text" id="aliments-error" style="display:none;">Ajoute au moins un aliment</p>
        </div>
        <div style="display:flex;gap:10px;margin-top:0.5rem;">
          <button class="btn btn-primary" id="save-meal" style="margin:0;width:auto;flex:1;">Enregistrer le repas</button>
          ${isEditing ? `<button id="delete-meal" aria-label="Supprimer ce repas" style="width:50px;height:50px;flex-shrink:0;border-radius:50px;border:1.5px solid var(--border);background:var(--card);color:var(--danger-text);display:flex;align-items:center;justify-content:center;">${ICON_TRASH}</button>` : ''}
        </div>
      </div>
    </div>
  `;
}

let editingMealId = null;
let modalAliments = [];
let editGenderTemp = null;

function attachWelcomeEvents(){
  const c = document.getElementById('btn-create');
  const back = document.getElementById('back-btn');
  if(c) c.onclick = () => { state.showCreate = true; render(); };
  if(back) back.onclick = () => { state.showCreate = false; render(); };

  const skipBtn = document.getElementById('skip-create-btn');
  if(skipBtn) skipBtn.onclick = async () => {
    skipBtn.textContent = 'Vérification...';
    await refreshKnownPlanningsFromMemberships();
    if(state.knownPlannings.length > 0){
      state.showCreate = false;
      render();
    } else {
      await showAlert("Toujours aucun accès trouvé pour ce compte. Vérifie que la personne qui t'a invité a bien utilisé le même email/numéro que celui avec lequel tu es connecté.");
      skipBtn.textContent = "On m'a déjà donné accès à un bébé";
    }
  };

  document.querySelectorAll('[data-switchid]').forEach(btn => {
    btn.onclick = async () => {
      await switchPlanning(btn.dataset.switchid, btn.dataset.switchrole);
    };
  });

  document.querySelectorAll('.gender-btn').forEach(btn => {
    btn.onclick = () => {
      createGender = btn.dataset.val;
      document.getElementById('gender-fille').classList.toggle('selected', createGender === 'fille');
      document.getElementById('gender-garcon').classList.toggle('selected', createGender === 'garcon');
    };
  });

  const createPhotoBtn = document.getElementById('create-photo-btn');
  const createPhotoInput = document.getElementById('create-photo-input');
  if(createPhotoBtn && createPhotoInput){
    createPhotoBtn.onclick = () => createPhotoInput.click();
    createPhotoInput.onchange = async () => {
      const file = createPhotoInput.files[0];
      if(!file) return;
      try{
        createPhoto = await resizeImageFile(file, 500, 0.8);
        const savedName = document.getElementById('baby-name-input').value;
        const savedBirthdate = document.getElementById('baby-birthdate-input').value;
        render();
        document.getElementById('baby-name-input').value = savedName;
        document.getElementById('baby-birthdate-input').value = savedBirthdate;
        if(createGender){
          document.getElementById('gender-fille').classList.toggle('selected', createGender === 'fille');
          document.getElementById('gender-garcon').classList.toggle('selected', createGender === 'garcon');
        }
      }catch(e){
        console.error('Erreur traitement photo', e);
        await showAlert("Impossible d'utiliser cette photo, réessaie avec une autre.");
      }
    };
  }

  const submitCreate = document.getElementById('submit-create');
  if(submitCreate){
    submitCreate.onclick = async () => {
      const val = document.getElementById('baby-name-input').value.trim();
      const birthdate = document.getElementById('baby-birthdate-input').value;
      let ageValid = true;
      if(birthdate){
        const ageMs = Date.now() - new Date(birthdate).getTime();
        const ageYears = ageMs / (1000 * 60 * 60 * 24 * 365.25);
        ageValid = ageYears >= 0 && ageYears <= 100;
      }
      document.getElementById('name-error').style.display = val ? 'none' : 'block';
      document.getElementById('birthdate-error').style.display = birthdate ? 'none' : 'block';
      document.getElementById('birthdate-range-error').style.display = (birthdate && !ageValid) ? 'block' : 'none';
      document.getElementById('gender-error').style.display = createGender ? 'none' : 'block';
      if(!val || !birthdate || !ageValid || !createGender) return;
      await createPlanning(val, birthdate, createGender, createPhoto);
    };
  }
}

function attachMainEvents(){
  loadPlanningMembersIfNeeded();

  document.querySelectorAll('.tab, .header-icon-btn, #avatar-btn').forEach(btn => {
    btn.onclick = () => { state.tab = btn.dataset.tab; saveLocal(); render(); };
  });


  const switchBabyBtn = document.getElementById('switch-baby-btn');
  if(switchBabyBtn) switchBabyBtn.onclick = () => { state.showBabySwitcher = true; render(); };

  const logoutBtn = document.getElementById('logout-btn');
  if(logoutBtn) logoutBtn.onclick = () => logOut();

  const babySwitcherOverlay = document.getElementById('baby-switcher-overlay');
  if(babySwitcherOverlay){
    babySwitcherOverlay.onclick = (e) => { if(e.target.id === 'baby-switcher-overlay'){ state.showBabySwitcher = false; render(); } };
    const closeBabySwitcher = document.getElementById('close-baby-switcher');
    if(closeBabySwitcher) closeBabySwitcher.onclick = () => { state.showBabySwitcher = false; render(); };

    document.querySelectorAll('[data-switchid]').forEach(btn => {
      btn.onclick = async () => {
        state.showBabySwitcher = false;
        await switchPlanning(btn.dataset.switchid, btn.dataset.switchrole);
      };
    });

    document.querySelectorAll('[data-forgetid]').forEach(btn => {
      btn.onclick = async () => {
        if(!(await showConfirm("Retirer l'accès à ce bébé pour ton compte ? Un administrateur devra te redonner accès si tu changes d'avis."))) return;
        await forgetPlanning(btn.dataset.forgetid);
      };
    });

    const addBabyBtn = document.getElementById('add-baby-btn');
    if(addBabyBtn) addBabyBtn.onclick = () => {
      unsubscribePlanning();
      state.planningId = null;
      state.role = null;
      state.showBabySwitcher = false;
      render();
    };
  }

  const photoBtn = document.getElementById('photo-btn');
  const photoInput = document.getElementById('photo-input');
  if(photoBtn && photoInput){
    photoBtn.onclick = () => photoInput.click();
    photoInput.onchange = async () => {
      const file = photoInput.files[0];
      if(!file) return;
      try{
        planningData.photo = await resizeImageFile(file, 500, 0.8);
        await savePlanningProfile({ photo: planningData.photo });
        render();
      }catch(e){
        console.error('Erreur traitement photo', e);
        await showAlert("Impossible d'utiliser cette photo, réessaie avec une autre.");
      }
    };
  }

  document.querySelectorAll('.edit-field-btn').forEach(btn => {
    btn.onclick = () => {
      state.editingField = btn.dataset.field;
      editGenderTemp = planningData.gender;
      render();
    };
  });

  const profileOverlay = document.getElementById('profile-modal-overlay');
  if(profileOverlay){
    profileOverlay.onclick = (e) => { if(e.target.id === 'profile-modal-overlay'){ state.editingField = null; render(); } };
    const closeProfileModal = document.getElementById('close-profile-modal');
    if(closeProfileModal) closeProfileModal.onclick = () => { state.editingField = null; render(); };

    document.querySelectorAll('#profile-modal-overlay .gender-btn').forEach(btn => {
      btn.onclick = () => {
        editGenderTemp = btn.dataset.val;
        document.getElementById('edit-gender-fille').classList.toggle('selected', editGenderTemp === 'fille');
        document.getElementById('edit-gender-garcon').classList.toggle('selected', editGenderTemp === 'garcon');
      };
    });

    const saveProfileField = document.getElementById('save-profile-field');
    if(saveProfileField){
      saveProfileField.onclick = async () => {
        const field = state.editingField;
        let fields = null;
        if(field === 'name'){
          const val = document.getElementById('edit-name-input').value.trim();
          if(!val){ document.getElementById('edit-name-error').style.display = 'block'; return; }
          planningData.babyName = val;
          fields = { babyName: val };
        } else if(field === 'birthdate'){
          const val = document.getElementById('edit-birthdate-input').value;
          if(!val){ document.getElementById('edit-birthdate-error').style.display = 'block'; return; }
          const ageYears = (Date.now() - new Date(val).getTime()) / (1000 * 60 * 60 * 24 * 365.25);
          if(ageYears < 0 || ageYears > 100){ document.getElementById('edit-birthdate-error').style.display = 'block'; return; }
          planningData.birthdate = val;
          fields = { birthdate: val };
        } else if(field === 'gender'){
          planningData.gender = editGenderTemp;
          fields = { gender: editGenderTemp };
        }
        if(fields) await savePlanningProfile(fields);
        state.editingField = null;
        render();
      };
    }
  }

  document.querySelectorAll('.stats-reaction-row').forEach(btn => {
    btn.onclick = () => {
      const key = btn.dataset.statskey;
      state.statsExpanded = state.statsExpanded === key ? null : key;
      render();
    };
  });

  document.querySelectorAll('.stats-category-row').forEach(btn => {
    btn.onclick = () => {
      const key = btn.dataset.catkey;
      state.statsExpandedCategory = state.statsExpandedCategory === key ? null : key;
      render();
    };
  });

  const fab = document.getElementById('fab-add');
  if(fab) fab.onclick = () => {
    editingMealId = null;
    modalAliments = [];
    state.showModal = true; render();
    setTimeout(()=>{
      const now = new Date();
      document.getElementById('date-input').value = localDateStr(now);
      document.getElementById('heure-input').value = now.toTimeString().slice(0,5);
    }, 0);
  };

  const editPseudoBtn = document.getElementById('edit-pseudo-btn');
  if(editPseudoBtn) editPseudoBtn.onclick = () => { state.editingPseudo = true; render(); };

  const pseudoEditOverlay = document.getElementById('pseudo-edit-overlay');
  if(pseudoEditOverlay){
    pseudoEditOverlay.onclick = (e) => { if(e.target.id === 'pseudo-edit-overlay'){ state.editingPseudo = false; render(); } };
    const closePseudoEdit = document.getElementById('close-pseudo-edit');
    if(closePseudoEdit) closePseudoEdit.onclick = () => { state.editingPseudo = false; render(); };

    const savePseudoBtn = document.getElementById('save-pseudo-btn');
    if(savePseudoBtn) savePseudoBtn.onclick = async () => {
      const val = document.getElementById('edit-pseudo-input').value.trim();
      if(!val){ document.getElementById('edit-pseudo-error').style.display = 'block'; return; }
      await saveUserProfile({ pseudo: val });
      await loadUserProfile();
      await updatePseudoEverywhere(val);
      state.editingPseudo = false;
      planningMembersForId = null;
      render();
      await loadPlanningMembersIfNeeded();
    };
  }

  document.querySelectorAll('[data-inviterole]').forEach(btn => {
    btn.onclick = () => { state.inviteRole = btn.dataset.inviterole; render(); };
  });

  const grantBtn = document.getElementById('grant-access-btn');
  if(grantBtn) grantBtn.onclick = async () => {
    const input = document.getElementById('grant-identifier-input');
    const identifier = input ? input.value.trim() : '';
    if(!state.inviteRole){ state.grantError = 'Sélectionne un rôle (Administrateur ou Lecture seule).'; state.grantSuccessMessage = null; render(); return; }
    state.grantBusy = true; state.grantError = null; state.grantSuccessMessage = null; render();
    const result = await grantAccess(state.planningId, identifier, state.inviteRole);
    state.grantBusy = false;
    if(!result.ok){ state.grantError = result.error; render(); return; }
    state.grantError = null;
    state.grantSuccessMessage = result.pending
      ? "Invitation enregistrée : l'accès sera donné automatiquement dès la création du compte avec cet email/numéro."
      : (result.updated ? "Rôle mis à jour !" : "Accès donné !");
    state.inviteRole = null;
    if(!result.pending){ planningMembersForId = null; }
    render();
    await loadPlanningMembersIfNeeded();
  };

  document.querySelectorAll('[data-revokeuid]').forEach(btn => {
    btn.onclick = async () => {
      if(!(await showConfirm("Retirer l'accès de cette personne à ce planning ?"))) return;
      const ok = await revokeAccess(state.planningId, btn.dataset.revokeuid);
      if(!ok){ await showAlert("Le retrait d'accès a échoué, réessaie."); return; }
      planningMembersForId = null;
      render();
      await loadPlanningMembersIfNeeded();
    };
  });

  document.querySelectorAll('[data-react]').forEach(btn => {
    btn.onclick = async () => {
      const meal = planningData.meals.find(m => m.id === btn.dataset.id);
      if(meal){
        const touchedIds = applyReactionToMatchingMeals(btn.dataset.food, btn.dataset.react);
        await saveMealsReactions(touchedIds);
        render();
      }
    };
  });

  document.querySelectorAll('.edit-meal-btn').forEach(btn => {
    btn.onclick = () => {
      const meal = planningData.meals.find(m => m.id === btn.dataset.editid);
      if(!meal) return;
      editingMealId = meal.id;
      modalAliments = meal.alimentsList && meal.alimentsList.length
        ? meal.alimentsList.slice()
        : (meal.aliments || '').split(',').map(s => s.trim()).filter(Boolean);
      state.showModal = true;
      render();
      setTimeout(() => {
        document.getElementById('moment-input').value = meal.moment;
        document.getElementById('date-input').value = meal.date;
        document.getElementById('heure-input').value = meal.heure;
      }, 0);
    };
  });

  const overlay = document.getElementById('modal-overlay');
  if(overlay){
    overlay.onclick = (e) => { if(e.target.id === 'modal-overlay'){ state.showModal = false; editingMealId = null; render(); } };
    document.getElementById('close-modal').onclick = () => { state.showModal = false; editingMealId = null; render(); };

    const HEURE_PAR_MOMENT = { 'Petit-déjeuner': '08:00', 'Déjeuner': '12:00', 'Goûter': '16:30', 'Dîner': '19:00' };
    const momentInput = document.getElementById('moment-input');
    if(momentInput) momentInput.onchange = () => {
      const heure = HEURE_PAR_MOMENT[momentInput.value];
      if(heure) document.getElementById('heure-input').value = heure;
    };

    function refreshAlimentChips(){
      const container = document.getElementById('aliment-chips');
      if(!container) return;
      container.style.marginBottom = modalAliments.length ? '8px' : '0';
      container.innerHTML = modalAliments.map((a, i) => `
        <span style="display:inline-flex;align-items:center;gap:6px;font-size:16px;background:var(--primary-light);color:var(--primary-text);padding:4px 6px 4px 12px;border-radius:20px;">
          ${escapeHtml(a)}
          <button type="button" class="chip-remove-btn" data-idx="${i}" aria-label="Retirer ${escapeHtml(a)}" style="background:none;border:none;color:var(--primary-text);width:20px;height:20px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:16px;cursor:pointer;">✕</button>
        </span>
      `).join('');
      bindChipRemoveButtons();
    }

    function bindChipRemoveButtons(){
      document.querySelectorAll('.chip-remove-btn').forEach(btn => {
        btn.onclick = () => {
          modalAliments.splice(Number(btn.dataset.idx), 1);
          refreshAlimentChips();
        };
      });
    }
    bindChipRemoveButtons();

    const deleteBtn = document.getElementById('delete-meal');
    if(deleteBtn){
      deleteBtn.onclick = async () => {
        if(!(await showConfirm('Supprimer ce repas ?'))) return;
        const mealId = editingMealId;
        planningData.meals = planningData.meals.filter(m => m.id !== mealId);
        await deleteMeal(mealId);
        state.showModal = false;
        editingMealId = null;
        render();
      };
    }

    const searchInput = document.getElementById('aliment-search-input');
    const suggBox = document.getElementById('aliment-suggestions');
    if(searchInput && suggBox){
      const normalize = s => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

      const showSuggestions = () => {
        document.getElementById('category-picker').style.display = 'none';
        const q = normalize(searchInput.value.trim());
        if(!q){ suggBox.style.display = 'none'; suggBox.innerHTML = ''; return; }
        const matches = FOOD_INDEX.filter(f => normalize(f.name).includes(q) && !modalAliments.includes(f.name)).slice(0, 8);
        let html = matches.map(f => `<button type="button" class="aliment-suggest-btn" data-food="${f.name}" style="display:block;width:100%;text-align:left;background:none;border:none;padding:10px 14px;font-size:16px;color:var(--text);cursor:pointer;border-bottom:1px solid var(--border);">${f.name} <span style="color:var(--text-muted);font-size:16px;">· ${f.cat}</span></button>`).join('');
        const typed = searchInput.value.trim();
        const exact = FOOD_INDEX.some(f => normalize(f.name) === q);
        if(typed && !exact && !modalAliments.includes(typed)){
          html += `<button type="button" class="aliment-suggest-btn" data-food="${escapeHtml(typed)}" style="display:block;width:100%;text-align:left;background:none;border:none;padding:10px 14px;font-size:16px;font-weight:600;color:var(--primary-text);cursor:pointer;">+ Ajouter "${escapeHtml(typed)}"</button>`;
        }
        suggBox.innerHTML = html || `<div style="padding:10px 14px;font-size:16px;color:var(--text-muted);">Aucun résultat</div>`;
        suggBox.style.display = 'block';
        document.querySelectorAll('.aliment-suggest-btn').forEach(btn => {
          btn.onclick = () => {
            const food = btn.dataset.food;
            if(!food) return;
            const isKnown = FOOD_INDEX.some(f => f.name === food);
            searchInput.value = '';
            suggBox.style.display = 'none';
            suggBox.innerHTML = '';
            if(isKnown){
              if(!modalAliments.includes(food)) modalAliments.push(food);
              refreshAlimentChips();
              searchInput.focus();
            } else {
              document.getElementById('category-picker-food').textContent = food;
              document.getElementById('category-picker').dataset.pendingFood = food;
              document.getElementById('category-picker').style.display = 'block';
            }
          };
        });
      };

      searchInput.oninput = showSuggestions;
      searchInput.onfocus = showSuggestions;
      searchInput.onblur = () => setTimeout(() => { suggBox.style.display = 'none'; }, 150);

      const categoryPicker = document.getElementById('category-picker');
      document.getElementById('category-picker-confirm').onclick = () => {
        const food = categoryPicker.dataset.pendingFood;
        const category = document.getElementById('category-picker-select').value;
        if(!food) return;
        if(!planningData.customCategories) planningData.customCategories = {};
        planningData.customCategories[food] = category;
        if(!modalAliments.includes(food)) modalAliments.push(food);
        categoryPicker.style.display = 'none';
        categoryPicker.dataset.pendingFood = '';
        refreshAlimentChips();
        searchInput.focus();
      };
    }

    document.getElementById('save-meal').onclick = async () => {
      document.getElementById('aliments-error').style.display = modalAliments.length ? 'none' : 'block';
      const date = document.getElementById('date-input').value;
      document.getElementById('date-error').style.display = date ? 'none' : 'block';
      if(!modalAliments.length || !date) return;

      const heure = document.getElementById('heure-input').value || '00:00';
      const dateTimeChoisie = new Date(date + 'T' + heure);
      const statutAuto = dateTimeChoisie.getTime() <= Date.now() ? 'passe' : 'futur';
      const categories = [...new Set(modalAliments.map(a => getCategoryForAliment(a)))];

      const fields = {
        statut: statutAuto,
        moment: document.getElementById('moment-input').value,
        date: date,
        heure: heure,
        aliments: modalAliments.join(', '),
        alimentsList: modalAliments.slice(),
        categories: categories,
        categorie: categories[0]
      };
      let meal;
      if(editingMealId){
        meal = planningData.meals.find(m => m.id === editingMealId);
        if(meal) Object.assign(meal, fields);
      } else {
        meal = Object.assign({ id: randomCode(8), reactions: {} }, fields);
        planningData.meals.push(meal);
      }
      await saveMeal(meal);
      state.showModal = false;
      state.tab = statutAuto === 'passe' ? 'historique' : 'planning';
      editingMealId = null;
      await saveLocal();
      render();
    };
  }
}

// Fait remonter le champ actif au-dessus du clavier mobile (le temps qu'il s'ouvre)
document.addEventListener('focusin', (e) => {
  if(e.target.matches('input, select, textarea')){
    setTimeout(scrollActiveFieldIntoView, 300);
  }
});

async function loadUserProfile(){
  if(!auth.currentUser) return;
  try{
    const doc = await db.collection('users').doc(auth.currentUser.uid).get();
    state.userProfile = doc.exists ? doc.data() : null;
  }catch(e){ console.error('Erreur chargement profil', e); state.userProfile = null; }
}

auth.getRedirectResult().catch((e) => {
  if(e && e.code){ state.authError = authErrorMessage(e); render(); }
});

auth.onAuthStateChanged(async (user) => {
  state.user = user;
  state.authLoading = false;
  if(user){
    state.authBusy = false;
    if(pendingSignupIdentifier){
      const { identifier, method } = pendingSignupIdentifier;
      pendingSignupIdentifier = null;
      await registerUserLookup(identifier);
      await saveUserProfile(method === 'phone' ? { phone: identifier, method } : { email: identifier, method });
      await consumePendingInvites(identifier);
    }
    await loadUserProfile();
    if(!state.userProfile || !state.userProfile.pseudo){
      state.needsPseudo = true;
      state.loading = false;
      render();
      return;
    }
    await loadLocal();
  } else {
    state.userProfile = null;
    state.loading = false;
    render();
  }
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  });
}
