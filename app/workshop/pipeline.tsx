import { ScrollView } from 'react-native';
import { YStack, XStack, Text, Button, Spinner } from 'tamagui';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useState, useEffect, useCallback } from 'react';
import { remoteWS } from '../../utils/websocket';

type StepStatus = 'pending' | 'running' | 'done' | 'error';

type StepDef = {
  key: string;
  title: string;
  desc: string;
  icon: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
};

const STEPS: StepDef[] = [
  { key: 'detect', title: '原创快筛', desc: 'AI 检测扫描', icon: 'magnify-scan' },
  { key: 'evaluate', title: '作品评估', desc: '画作分析', icon: 'chart-bar' },
  { key: 'copywrite', title: '文案生成', desc: '自动撰写发布文案', icon: 'text-box' },
  { key: 'pack', title: '发布打包', desc: '多平台裁切导出', icon: 'package-variant' },
  { key: 'certify', title: '确权存证', desc: '时间戳 + 版权保护', icon: 'shield-check' },
  { key: 'publish', title: '聚合上传', desc: '发布到各平台', icon: 'upload' },
];

export default function PipelineScreen() {
  const [stepStatus, setStepStatus] = useState<Record<string, StepStatus>>({});
  const [isRunning, setIsRunning] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [connected, setConnected] = useState(remoteWS.getState() === 'connected');

  useEffect(() => {
    const unsubState = remoteWS.onStateChange(s => setConnected(s === 'connected'));

    const unsubMsg = remoteWS.onMessage(msg => {
      if (msg.type !== 'event' || !msg.action || !msg.data) return;

      const { action, data } = msg;

      switch (action) {
        case 'pipeline_step_started': {
          const stepId = data.stepId as string;
          setStepStatus(prev => ({ ...prev, [stepId]: 'running' }));
          setErrorMsg('');
          break;
        }
        case 'pipeline_step_finished': {
          const stepId = data.stepId as string;
          setStepStatus(prev => ({ ...prev, [stepId]: 'done' }));
          break;
        }
        case 'pipeline_step_error': {
          const stepId = data.stepId as string;
          const error = (data.error || '') as string;
          setStepStatus(prev => ({ ...prev, [stepId]: 'error' }));
          setErrorMsg(`${stepId}: ${error}`);
          break;
        }
        case 'pipeline_all_finished': {
          setIsRunning(false);
          break;
        }
      }
    });

    return () => { unsubState(); unsubMsg(); };
  }, []);

  const startPipeline = useCallback(() => {
    if (!connected || isRunning) return;

    // Reset state
    setStepStatus({});
    setErrorMsg('');
    setIsRunning(true);

    const sent = remoteWS.sendPipelineStart({});
    if (!sent) {
      setIsRunning(false);
      setErrorMsg('桌面端未连接');
    }
  }, [connected, isRunning]);

  const getStatus = (key: string): StepStatus => stepStatus[key] || 'pending';

  return (
    <ScrollView style={{ flex: 1, backgroundColor: '#f5f5f7' }} contentContainerStyle={{ padding: 20 }}>
      {STEPS.map((step, index) => {
        const status = getStatus(step.key);
        const isActive = status === 'running';
        const isDone = status === 'done';
        const isError = status === 'error';

        const dotBg = isDone ? '#4ade80'
          : isActive ? '#b388ff'
          : isError ? '#ff6b6b'
          : '#e8e8e8';
        const iconColor = (isDone || isActive || isError) ? '#fff' : '#bbbbbb';

        const stepIcon = isDone ? 'check'
          : isError ? 'close'
          : step.icon;

        return (
          <XStack key={step.key} marginBottom="$1">
            {/* Step indicator */}
            <YStack width={40} alignItems="center">
              <YStack
                width={36} height={36} borderRadius={18}
                backgroundColor={dotBg}
                justifyContent="center" alignItems="center"
              >
                {isActive ? (
                  <Spinner size="small" color="#fff" />
                ) : (
                  <MaterialCommunityIcons name={stepIcon} size={18} color={iconColor} />
                )}
              </YStack>
              {index < STEPS.length - 1 && (
                <YStack
                  width={2} flex={1} marginVertical="$1"
                  backgroundColor={isDone ? '#4ade80' : '#e8e8e8'}
                />
              )}
            </YStack>

            {/* Step card */}
            <YStack
              flex={1}
              marginLeft="$3"
              marginBottom="$2"
              backgroundColor="#ffffff"
              borderRadius="$3"
              padding="$3"
              borderWidth={isActive ? 1 : isError ? 1 : 0}
              borderColor={isActive ? '#b388ff' : isError ? '#ff6b6b' : undefined}
            >
              <Text
                color={isActive ? '#b388ff' : isError ? '#ff6b6b' : '#1d1d1f'}
                fontSize={15} fontWeight="600"
              >
                {step.title}
                {isDone && ' ✓'}
              </Text>
              <Text color="#999999" fontSize={12} marginTop="$1">{step.desc}</Text>
            </YStack>
          </XStack>
        );
      })}

      {/* Error message */}
      {errorMsg ? (
        <YStack backgroundColor="#fff3f3" borderRadius="$3" padding="$3" marginBottom="$3">
          <Text color="#cc4444" fontSize={13}>{errorMsg}</Text>
        </YStack>
      ) : null}

      {/* Action button */}
      <Button
        size="$5"
        backgroundColor={isRunning ? '#999' : connected ? '#b388ff' : '#ccc'}
        borderRadius="$3"
        marginTop="$3"
        pressStyle={{ opacity: 0.85 }}
        onPress={startPipeline}
        disabled={isRunning || !connected}
      >
        {isRunning ? (
          <XStack alignItems="center" gap="$2">
            <Spinner size="small" color="#fff" />
            <Text color="white" fontWeight="600" fontSize={16}>运行中...</Text>
          </XStack>
        ) : (
          <Text color="white" fontWeight="600" fontSize={16}>
            {connected ? '启动流水线' : '桌面端未连接'}
          </Text>
        )}
      </Button>
    </ScrollView>
  );
}
