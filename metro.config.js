// Expo default Metro config + web-only module aliases.
// react-native-pager-view imports RN internals unavailable on web; alias it to
// a ScrollView-based shim for the web bundle only. Native bundles are untouched.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const config = getDefaultConfig(__dirname);

const WEB_ALIASES = {
  'react-native-pager-view': path.resolve(__dirname, 'web-shims/PagerView.web.tsx'),
  'react-native-share': path.resolve(__dirname, 'web-shims/react-native-share.web.js'),
};

const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (platform === 'web' && WEB_ALIASES[moduleName]) {
    return { type: 'sourceFile', filePath: WEB_ALIASES[moduleName] };
  }
  if (defaultResolveRequest) {
    return defaultResolveRequest(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
