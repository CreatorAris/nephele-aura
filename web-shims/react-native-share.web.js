// Web stub for react-native-share. The real module is a codegen TurboModule
// (TurboModuleRegistry.getEnforcing('RNShare')) that throws on web at import.
// On web we fall back to the Web Share API when available; otherwise no-op.
const Share = {
  async open(options = {}) {
    if (typeof navigator !== 'undefined' && navigator.share) {
      const data = {};
      if (options.message) data.text = options.message;
      if (options.title) data.title = options.title;
      if (options.url) data.url = options.url;
      await navigator.share(data);
      return { success: true };
    }
    throw new Error('Web Share API unavailable');
  },
  async shareSingle() {
    throw new Error('shareSingle is not supported on web');
  },
  Social: {},
};

export default Share;
