// Expo's MainActivity template calls DefaultReactActivityDelegate(activity, name, fabricEnabled).
// React Native 0.88 marks that constructor deprecated and ignores the flag
// (ReactAndroid/.../defaults/DefaultReactActivityDelegate.kt), so use the two-argument one.
const { withMainActivity } = require('expo/config-plugins');

module.exports = function withMainActivityDelegate(config) {
  return withMainActivity(config, (cfg) => {
    let src = cfg.modResults.contents;
    src = src.replace(
      /DefaultReactActivityDelegate\(\s*this,\s*mainComponentName,\s*fabricEnabled\s*\)/,
      'DefaultReactActivityDelegate(this, mainComponentName)',
    );
    if (!/fabricEnabled\s*[,)]/.test(src.replace(/^\s*(\*|\/\/).*$/gm, ''))) {
      src = src.replace(/^import com\.facebook\.react\.defaults\.DefaultNewArchitectureEntryPoint\.fabricEnabled\n/m, '');
    }
    cfg.modResults.contents = src;
    return cfg;
  });
};
