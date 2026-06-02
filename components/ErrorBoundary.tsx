import { Component, type ReactNode } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { colors } from '../theme/colors';
import analytics from '../utils/analytics';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

/**
 * Catches render-phase crashes in the React tree, reports them through the
 * telemetry relay (same channel as the global JS handler, tagged
 * boundary:true + a component stack), and shows a branded fallback instead of
 * a white/red screen. Complements the ErrorUtils global handler in _layout,
 * which catches the async / non-render errors a boundary can't see.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: { componentStack?: string }): void {
    try {
      analytics.capture('app_error', {
        fatal: false,
        boundary: true,
        name: error?.name,
        message: String(error?.message ?? '').slice(0, 300),
        stack: String(error?.stack ?? '').slice(0, 1000),
        component_stack: String(info?.componentStack ?? '').slice(0, 1000),
      });
      void analytics.flush();
    } catch {
      // Reporting must never mask the original render error.
    }
  }

  private reset = (): void => this.setState({ hasError: false });

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children;
    return (
      <View style={styles.container}>
        <Text style={styles.title}>出了点问题</Text>
        <Text style={styles.body}>这一屏崩溃了，已经记录下来。点下面重试。</Text>
        <Pressable style={styles.button} onPress={this.reset} accessibilityRole="button">
          <Text style={styles.buttonText}>重试</Text>
        </Pressable>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    backgroundColor: colors.bg.canvas,
  },
  title: {
    fontSize: 18,
    fontWeight: '600',
    color: colors.text.primary,
    marginBottom: 8,
  },
  body: {
    fontSize: 14,
    color: colors.text.secondary,
    textAlign: 'center',
    marginBottom: 24,
  },
  button: {
    paddingHorizontal: 28,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: colors.brand.primary,
  },
  buttonText: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.bg.canvas, // dark text on brand purple — white would vanish
  },
});

export default ErrorBoundary;
