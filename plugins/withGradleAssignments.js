// Gradle 9 deprecates setting properties as `prop value` in Groovy build files (removed in
// Gradle 10; see https://docs.gradle.org/current/userguide/upgrading_major_version_9.html).
// Expo's generated android/app/build.gradle still uses that form, so rewrite the properties
// Gradle reports to `prop = value`. Method calls such as minSdkVersion(...) are left alone.
const { withAppBuildGradle } = require('expo/config-plugins');

const PROPS = [
  'ndkVersion', 'buildToolsVersion', 'compileSdk', 'namespace', 'applicationId',
  'versionCode', 'versionName', 'storeFile', 'storePassword', 'keyAlias', 'keyPassword',
  'signingConfig', 'shrinkResources', 'minifyEnabled', 'crunchPngs', 'useLegacyPackaging',
  'ignoreAssetsPattern',
];
const RE = new RegExp(`^(\\s*)(${PROPS.join('|')})\\s+(?!=)(\\S.*)$`, 'gm');

module.exports = function withGradleAssignments(config) {
  return withAppBuildGradle(config, (cfg) => {
    if (cfg.modResults.language === 'groovy') {
      cfg.modResults.contents = cfg.modResults.contents.replace(RE, '$1$2 = $3');
    }
    return cfg;
  });
};
