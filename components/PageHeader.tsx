import { View, StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Text } from 'tamagui';

type Props = {
  title: string;
  subtitle?: string;
};

export default function PageHeader({ title, subtitle }: Props) {
  return (
    <View style={styles.container}>
      <LinearGradient
        colors={['#f8f0ff', '#f5f5f7']}
        style={styles.gradient}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
      />
      <View style={styles.content}>
        <Text fontSize={28} fontWeight="700" color="#1d1d1f">{title}</Text>
        {subtitle && (
          <Text fontSize={13} color="#b388ff" marginTop="$1" fontWeight="500">{subtitle}</Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { position: 'relative' },
  gradient: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
  },
  content: {
    padding: 16,
    paddingBottom: 8,
  },
});
