// Expo's template pins Gradle 9.4.1, the minimum for Android Gradle Plugin 9.2
// (https://developer.android.com/build/releases/agp-9-2-0-release-notes). gradle/actions
// flags it as out of date, so the wrapper is moved to the current 9.x release.
const fs = require('fs');
const path = require('path');
const { withDangerousMod } = require('expo/config-plugins');

const GRADLE_VERSION = '9.8.2';

module.exports = function withGradleWrapperVersion(config) {
  return withDangerousMod(config, [
    'android',
    async (cfg) => {
      const file = path.join(cfg.modRequest.platformProjectRoot, 'gradle', 'wrapper', 'gradle-wrapper.properties');
      const src = fs.readFileSync(file, 'utf8');
      const out = src.replace(
        /^distributionUrl=.*$/m,
        `distributionUrl=https\\://services.gradle.org/distributions/gradle-${GRADLE_VERSION}-bin.zip`,
      );
      if (out === src && !src.includes(GRADLE_VERSION)) throw new Error('gradle-wrapper.properties: distributionUrl not found');
      fs.writeFileSync(file, out);
      return cfg;
    },
  ]);
};
