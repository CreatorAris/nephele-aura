import { Platform, StyleSheet, type ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import type { ReactNode } from 'react';

// Glass card — desktop midnight recipe: violet gradient + brand-purple rim
// light (glassRim) + soft lift. `elevated` brightens it (desktop bgElevated)
// for popovers/modals/sheets that must read as ABOVE the cards, not behind.
export function GlassCard({ children, style, elevated = false }: {
  children: ReactNode; style?: ViewStyle; elevated?: boolean;
}) {
  return (
    <LinearGradient
      colors={elevated ? ['#403979', '#332C5E'] : ['#332D5C', '#2A2548']}
      start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }}
      style={[styles.card, elevated ? styles.elevated : null, style]}
    >
      {children}
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 24,
    padding: 20,
    gap: 18,
    borderWidth: 1,
    borderColor: 'rgba(206,172,224,0.22)',   // 25% brand-purple rim light
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOpacity: 0.4, shadowRadius: 18, shadowOffset: { width: 0, height: 10 } },
      android: { elevation: 12 },
    }),
  },
  elevated: {
    borderColor: 'rgba(206,172,224,0.34)',   // brighter rim — reads as lifted above the cards
  },
});
