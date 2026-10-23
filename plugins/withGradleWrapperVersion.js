// Expo's template pins Gradle 9.4.1, the minimum for Android Gradle Plugin 9.2
// (https://developer.android.com/build/releases/agp-9-2-0-release-notes). gradle/actions
// flags versions more than two minor releases behind the latest as out of date.
// 9.6.1 is the newest that works here: it embeds Kotlin 2.3.21 and is tested with AGP 9.2.1
// (gradle/gradle v9.6.1: gradle/dependency-management/distribution.versions.toml and
// agp-versions.properties). Gradle 9.7+ embeds Kotlin 2.4, which React Native 0.88's Gradle
// plugin (compiled with Kotlin 2.2, reads metadata up to 2.3) cannot load.
const fs = require('fs');
const path = require('path');
const { withDangerousMod } = require('expo/config-plugins');

const GRADLE_VERSION = '9.6.1';

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
