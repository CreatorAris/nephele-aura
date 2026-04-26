import { config as defaultConfig } from '@tamagui/config/v3';
import { createTamagui } from 'tamagui';

const config = createTamagui({
  ...defaultConfig,
  themes: {
    ...defaultConfig.themes,
    dark_nephele: {
      ...defaultConfig.themes.dark,
      background: '#0f0f1a',
      backgroundHover: '#1a1a2e',
      backgroundPress: '#252540',
      backgroundFocus: '#1a1a2e',
      color: '#e0e0e0',
      colorHover: '#ffffff',
      colorPress: '#888888',
      borderColor: '#2a2a3e',
      borderColorHover: '#353550',
      borderColorFocus: '#b388ff',
    },
  },
});

export default config;

export type AppConfig = typeof config;

declare module 'tamagui' {
  interface TamaguiCustomConfig extends AppConfig {}
}
