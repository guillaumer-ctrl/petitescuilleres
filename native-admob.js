// Publicites AdMob + consentement RGPD (Google UMP), actives uniquement dans
// l'app Android empaquetee (Capacitor) -- sans effet sur la version web/PWA,
// ou l'objet global Capacitor n'existe pas.
//
// Les identifiants ci-dessous sont les IDs DE TEST officiels de Google : ils
// affichent toujours une publicite de demonstration, jamais de vraie pub, et
// ne generent aucun revenu. A remplacer par les vrais identifiants une fois
// le compte AdMob cree et les unites publicitaires configurees (voir
// PLAY_STORE_CHECKLIST.md).
(function () {
  if (typeof Capacitor === 'undefined' || !Capacitor.isNativePlatform || !Capacitor.isNativePlatform()) return;
  const AdMob = Capacitor.Plugins && Capacitor.Plugins.AdMob;
  if (!AdMob) return;

  const TEST_APP_OPEN_BANNER_ID = 'ca-app-pub-3940256099942544/6300978111';
  const TEST_INTERSTITIAL_ID = 'ca-app-pub-3940256099942544/1033173712';
  const MIN_INTERSTITIAL_INTERVAL_MS = 3 * 60 * 1000; // pas plus d'une interstitielle toutes les 3 min

  let adsReady = false;
  let lastInterstitialAt = 0;

  async function initAds() {
    try {
      // Formulaire de consentement RGPD (Google UMP) : obligatoire avant
      // toute publicite personnalisee pour les utilisateurs europeens.
      const consentInfo = await AdMob.requestConsentInfo();
      if (consentInfo.isConsentFormAvailable) {
        await AdMob.showConsentForm();
      }
      await AdMob.initialize();
      adsReady = true;
      await AdMob.showBanner({
        adId: TEST_APP_OPEN_BANNER_ID,
        adSize: 'ADAPTIVE_BANNER',
        position: 'BOTTOM_CENTER',
        margin: 0,
      });
    } catch (e) {
      console.error('Erreur initialisation AdMob', e);
    }
  }

  // Appelee depuis l'app a des moments neutres uniquement (ex: apres l'ajout
  // d'un repas) -- jamais juste apres une reaction "allergie", pour ne pas
  // interrompre un moment potentiellement anxiogene pour le parent.
  window.__showInterstitialAd = async function () {
    if (!adsReady) return;
    const now = Date.now();
    if (now - lastInterstitialAt < MIN_INTERSTITIAL_INTERVAL_MS) return;
    try {
      await AdMob.prepareInterstitial({ adId: TEST_INTERSTITIAL_ID });
      await AdMob.showInterstitial();
      lastInterstitialAt = now;
    } catch (e) {
      console.error('Erreur interstitielle AdMob', e);
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAds);
  } else {
    initAds();
  }
})();
