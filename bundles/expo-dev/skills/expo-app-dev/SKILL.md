---
name: expo-app-dev
description: Expo development workflow for {{project.name}} — Expo Go vs development builds, prebuild/CNG, running on simulators, emulators, and devices, and EAS Build/Submit/Update. Use when setting up, running, or shipping the app.
user-invocable: false
---

# Expo App Development Workflow

## App Configuration

Core identity lives in `app.json` (or `app.config.ts` when values must be computed):

```json
{
  "expo": {
    "name": "{{project.name}}",
    "slug": "{{app.slug}}",
    "scheme": "{{app.scheme}}",
    "ios": { "bundleIdentifier": "{{app.iosBundleId}}" },
    "android": { "package": "{{app.androidPackage}}" }
  }
}
```

Use `app.config.ts` for dynamic values (env-dependent names, per-profile identifiers); it receives the static config and returns the final one.

## Expo Go vs Development Builds

| Client | When it works |
| --- | --- |
| Expo Go | Only while every dependency is inside the Expo SDK — no config plugins, no custom native modules |
| Development build | Everything else — any config plugin or native module means building your own dev client |

Decision rule: the moment the app needs anything outside the Expo SDK, switch to a development build. Build one locally with `npx expo run:ios` / `npx expo run:android`, or make a shareable/installable one with `eas build --profile development`.

## Continuous Native Generation (CNG / Prebuild)

`ios/` and `android/` are **build artifacts**, not source:

- Keep them gitignored; regenerate with `npx expo prebuild --clean`
- Never hand-edit the generated projects — changes are lost on the next prebuild
- Express native changes as config plugins in the app config instead

## Daily Dev Loop

- `npx expo start` — Metro dev server; press `i` for iOS simulator, `a` for Android emulator, scan the QR code for a physical device
- `npx expo start --clear` — reset the Metro cache when bundling behaves strangely
- Rebuild rule: JS and asset changes hot-reload via fast refresh; a new native dependency or an app-config/plugin change requires rebuilding the native app (`run:ios` / `run:android` or a new EAS build)

## EAS Basics

- `eas.json` defines build profiles — conventionally `development`, `preview`, `production`
- `eas build --platform ios|android|all --profile <name>` — cloud native builds
- `eas submit` — upload to App Store Connect / Google Play
- `eas update` — ship JS-only changes over the air to existing builds
- Runtime-version gating: an update only reaches builds whose runtime version matches. Any native change (new module, config plugin, SDK upgrade) bumps the runtime version and always means a new store build.
- CI authenticates with an `EAS_TOKEN` environment variable instead of interactive login

## Common Failure Modes

- **SDK mismatch**: the installed Expo Go only supports specific SDK versions — upgrade the app (`npx expo install --fix`) or use a development build
- **"Native module not found"** right after adding a dependency: the native app is stale — rebuild, don't just restart Metro
- **Weird bundling/transform errors**: stale Metro cache — `npx expo start --clear`
- **Prebuild drift**: someone hand-edited `ios/`/`android/` — port the change to a config plugin, then `npx expo prebuild --clean` to confirm nothing is lost
