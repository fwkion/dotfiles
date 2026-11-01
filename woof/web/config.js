// Site configuration. At deploy time Terraform can overwrite this file.
window.WOOF_CONFIG = {
  // Where the API lives. "/api" = same domain (CloudFront routes /api/* to
  // the Lambda). Use a full URL if the API is on its own domain.
  apiBase: '/api',

  // Optional: shown as "Call" / "WhatsApp" buttons. International format,
  // e.g. "+447700900123". Leave empty to hide.
  ownerPhone: '',

  // Optional: a photo helps a finder confirm it's the right dog. e.g. "dog.jpg"
  photoUrl: '',

  // Ask for the visitor's location as soon as the page opens (recommended:
  // most people scan, glance and leave). If false, only on button tap.
  autoRequestLocation: true,

  // Map shown before we know where the visitor is.
  defaultMapCenter: [54.5, -3.0], // UK
  defaultMapZoom: 5,
};
