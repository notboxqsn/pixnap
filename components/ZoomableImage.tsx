import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  runOnJS,
} from 'react-native-reanimated';

interface ZoomableImageProps {
  uri: string;
  aspectRatio: number;
  children?: React.ReactNode;
}

const MIN_SCALE = 1;
const MAX_SCALE = 5;

export default function ZoomableImage({ uri, aspectRatio, children }: ZoomableImageProps) {
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const savedTranslateX = useSharedValue(0);
  const savedTranslateY = useSharedValue(0);
  const focalX = useSharedValue(0);
  const focalY = useSharedValue(0);

  const pinchGesture = Gesture.Pinch()
    .onStart((e) => {
      'worklet';
      focalX.value = e.focalX;
      focalY.value = e.focalY;
    })
    .onUpdate((e) => {
      'worklet';
      const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, savedScale.value * e.scale));
      scale.value = newScale;
    })
    .onEnd(() => {
      'worklet';
      savedScale.value = scale.value;
      if (scale.value <= 1.05) {
        scale.value = withTiming(1);
        savedScale.value = 1;
        translateX.value = withTiming(0);
        translateY.value = withTiming(0);
        savedTranslateX.value = 0;
        savedTranslateY.value = 0;
      }
    });

  const panGesture = Gesture.Pan()
    .minPointers(1)
    .onUpdate((e) => {
      'worklet';
      if (savedScale.value > 1) {
        translateX.value = savedTranslateX.value + e.translationX;
        translateY.value = savedTranslateY.value + e.translationY;
      }
    })
    .onEnd(() => {
      'worklet';
      savedTranslateX.value = translateX.value;
      savedTranslateY.value = translateY.value;
    });

  const doubleTapGesture = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      'worklet';
      if (savedScale.value > 1.1) {
        scale.value = withTiming(1);
        savedScale.value = 1;
        translateX.value = withTiming(0);
        translateY.value = withTiming(0);
        savedTranslateX.value = 0;
        savedTranslateY.value = 0;
      } else {
        scale.value = withTiming(2.5);
        savedScale.value = 2.5;
      }
    });

  const composed = Gesture.Exclusive(
    doubleTapGesture,
    Gesture.Simultaneous(pinchGesture, panGesture),
  );

  const animatedStyle = useAnimatedStyle(() => {
    'worklet';
    return {
      transform: [
        { translateX: translateX.value },
        { translateY: translateY.value },
        { scale: scale.value },
      ],
    };
  });

  return (
    <GestureDetector gesture={composed}>
      <Animated.View style={[styles.container, animatedStyle]}>
        {children}
        <Animated.Image
          source={{ uri }}
          style={[styles.image, { aspectRatio }]}
          resizeMode="contain"
        />
      </Animated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 16,
    justifyContent: 'center',
  },
  image: {
    width: '100%',
  },
});
