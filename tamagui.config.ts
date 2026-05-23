import { config as defaultConfig } from '@tamagui/config/v3';
import { createTamagui } from 'tamagui';

const config = createTamagui({
  ...defaultConfig,
  themes: {
    ...defaultConfig.themes,
    // "midnight" — mirrors desktop gui/qml/core/Theme.qml so Tamagui-defaulted
    // components (Input, Button) match the colors.ts tokens used everywhere else.
    dark_nephele: {
      ...defaultConfig.themes.dark,
      background: '#1A1438',
      backgroundHover: '#2E2A48',
      backgroundPress: '#33285C',
      backgroundFocus: '#2E2A48',
      color: '#F5F2FF',
      colorHover: '#FFFFFF',
      colorPress: '#C0B5DC',
      borderColor: '#3A3458',
      borderColorHover: '#4F4773',
      borderColorFocus: '#CEACE0',
    },
  },
});

export default config;

export type AppConfig = typeof config;

declare module 'tamagui' {
  interface TamaguiCustomConfig extends AppConfig {}
}
