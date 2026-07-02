---
name: expo-ui
description: Native UI with @expo/ui — SwiftUI on iOS, Jetpack Compose on Android, DOM on web — components, modifiers, and interop with React Native views. Use when building or reviewing screens that use @expo/ui.
user-invocable: false
---

# Expo UI Reference

## Versioning Ground Rules

- `@expo/ui` is **stable as of Expo SDK 56**. It ships in the default `create-expo-app` template and works in Expo Go (SDK 56+).
- The APIs went through breaking changes across SDK 53–55 (alpha/beta; Jetpack Compose support only landed in 55). **Examples targeting SDK ≤55 are unreliable** — pin all guidance, searches, and doc lookups to SDK 56+.

## The Host Rule

Every universal `@expo/ui` subtree must be rooted in a `Host`. `Host` is the bridge component: it takes React Native styles (flex, position, dimensions); everything inside it is native SwiftUI/Compose layout.

```tsx
import { Host, Column, Text, Button } from '@expo/ui';

export default function Example() {
  return (
    <Host style={{ flex: 1 }}>
      <Column spacing={12} alignment="center">
        <Text>Hello, world!</Text>
        <Button label="Press me" onPress={() => console.log('Pressed')} />
      </Column>
    </Host>
  );
}
```

## Universal Components

One import, native implementation per platform (SwiftUI on iOS, Jetpack Compose on Android, DOM/react-native-web on web):

- **Container**: `Host` (required root)
- **Layout**: `Column`, `Row`, `Spacer`, `ScrollView`
- **Display**: `Text`, `Icon`
- **Controls**: `Button`, `Switch`, `Checkbox`, `Slider`, `TextInput`, `Picker`
- **Disclosure / presentation**: `BottomSheet`, `Collapsible`
- **Collections / forms**: `List`, `FieldGroup`

## Platform-Specific Layers

For full platform fidelity, drop to `@expo/ui/swift-ui` or `@expo/ui/jetpack-compose`. These expose idioms the universal layer doesn't (SwiftUI `Form`/`Section`, SF Symbols, `HStack`/`VStack`; Compose equivalents on Android).

```tsx
import { Host, Form, Section, HStack, Spacer, Toggle, Image, Text } from '@expo/ui/swift-ui';

<Host style={{ flex: 1 }}>
  <Form>
    <Section>
      <HStack spacing={8}>
        <Image systemName="airplane" color="white" size={18} />
        <Text>Airplane Mode</Text>
        <Spacer />
        <Toggle isOn={isOn} onIsOnChange={setIsOn} />
      </HStack>
    </Section>
  </Form>
</Host>
```

Note: the swift-ui `Button` is a container — its children are the label — unlike the universal `Button`'s `label` prop.

## Modifiers

Styling and behavior attach via the `modifiers` prop, an array applied in order (mirrors SwiftUI modifier chaining / Compose `Modifier`):

- `@expo/ui/swift-ui/modifiers`: `background`, `cornerRadius`, `padding`, `shadow`, `foregroundColor` / `foregroundStyle`, `onTapGesture`, `glassEffect`, `buttonStyle`, `clipShape`, `frame`, `scaleEffect`, `opacity`
- `@expo/ui/jetpack-compose/modifiers`: `paddingAll`, `padding`, `size`, `fillMaxWidth`, `background`, `clickable`, `clip`, `Shapes`

```tsx
import { Text, Host } from '@expo/ui/swift-ui';
import { background, cornerRadius, padding, shadow, opacity } from '@expo/ui/swift-ui/modifiers';

<Text
  modifiers={[
    background('#4ECDC4'),
    cornerRadius(16),
    padding({ horizontal: 20, vertical: 12 }),
    ...(isEnabled ? [shadow({ radius: 6, y: 3 })] : [opacity(0.7)]),
  ]}>
  Conditionally styled
</Text>
```

`glassEffect` (Liquid Glass) requires iOS 26+ and building with Xcode 26+.

## Interop and Routing Gotchas

- An expo-router `<Link asChild>` wrapping a `Button` needs `modifiers={[buttonStyle('plain')]}` on the button, or it gets the default blue tint.
- `Text` inside a `Link` needs an explicit color via `foregroundStyle({ type: 'color', color: ... })` — it won't inherit one.
- `Host` composes with React Native trees: give it absolute positioning to overlay native UI on RN views, or `flex: 1` to fill a slot in an RN layout.

## Choosing a Layer

- **Universal `@expo/ui`** — default for cross-platform screens that should look native on both platforms.
- **`@expo/ui/swift-ui` / `@expo/ui/jetpack-compose`** — when a platform idiom matters (Settings-style `Form`, SF Symbols, platform-specific modifiers).
- **React Native core views** — custom-drawn or brand-heavy UI, and wherever the mature RN ecosystem (gesture handlers, virtualized lists) wins.
