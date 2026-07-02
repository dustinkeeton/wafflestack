---
name: tdd
description: Test-Driven Development skill. Guides writing tests before implementation using Vitest, co-located test files, and centralized Obsidian mocks. Enforces Red-Green-Refactor cycle.
user-invocable: true
---

# Test-Driven Development (TDD)

When this skill is invoked, follow the TDD workflow below. If invoked with arguments (e.g., `/tdd src/shared/validation.ts`), scope the work to that file or module. If invoked without arguments, audit the codebase for missing test coverage and propose a plan.

## Framework & Structure

- **Test runner:** Vitest (`npm test` to run, `npm run test:watch` for watch mode)
- **Test files:** Co-located next to source as `<name>.test.ts` (e.g., `src/shared/validation.test.ts`)
- **Obsidian mock:** `src/__mocks__/obsidian.ts` — centralized mock for the `obsidian` module
- **Test utilities:** `src/__test-utils__/` — mock factories, fixtures, helpers

## Red-Green-Refactor Cycle

When implementing a new function, class, or feature:

1. **RED** — Write a failing test first. Run `npx vitest run <file>` to confirm it fails.
2. **GREEN** — Write the minimum implementation to make the test pass.
3. **REFACTOR** — Clean up both test and production code. Run tests again to confirm they still pass.

Every new `.ts` file must have a corresponding `.test.ts` file, unless it is:
- A type-only file (`types.ts`)
- A re-export barrel (`index.ts` that only re-exports)
- A UI class extending Obsidian `Modal`, `ItemView`, or `PluginSettingTab` (test these indirectly through their callers, or extract testable logic into pure functions)

## Test Priority Tiers

{{tdd.priorityTiers}}

## Test Quality Rules

1. **Arrange-Act-Assert** — Every test follows AAA with clear separation.
2. **Descriptive names** — `it('returns null when file is in excluded folder')`, not `it('test 1')`.
3. **One behavior per test** — Multiple assertions OK only when verifying facets of the same behavior.
4. **No test interdependence** — Each test sets up its own fixtures. No shared mutable state.
5. **Mock at the boundary** — Mock external dependencies (`fetch`, `requestUrl`, `execFile`, Obsidian APIs), not internal functions. If you need to mock an internal function, refactor to inject the dependency.
6. **No real API calls** — Tests must never hit real network endpoints. Mock all HTTP.
7. **Security functions get exhaustive coverage** — `sanitizeUrl`, `sanitizePath`, `sanitizeAIResponse` must test: null bytes, path traversal, shell metacharacters, non-HTTP schemes, XSS vectors, and each pattern the sanitizer strips.

## Mocking Patterns

### Obsidian module mock
All tests automatically use `src/__mocks__/obsidian.ts` via Vitest's auto-mocking. This provides stub classes for `TFile`, `TFolder`, `Plugin`, `Modal`, `Notice`, `normalizePath`, `requestUrl`, etc.

### Mock factories (in `src/__test-utils__/`)
- `createMockApp()` — Returns a fresh `App` with spy vault/metadataCache/workspace
- `createMockPlugin(settingsOverrides?)` — Returns a Plugin with pre-loaded settings
- `makeSettings(overrides?)` — Returns `DEFAULT_SETTINGS` deep-merged with overrides
- `mockFile(path)` — Creates a `TFile` instance with the given path

### Mocking `fetch` (for Transcriber)
```typescript
beforeEach(() => { global.fetch = vi.fn(); });
afterEach(() => { vi.restoreAllMocks(); });
```

### Mocking `child_process` (for AudioExtractor)
```typescript
vi.mock('child_process', () => ({
  execFile: vi.fn((cmd, args, opts, cb) => cb(null, '{}', '')),
}));
```

## Architectural Test Rules

1. {{tdd.moduleBoundaries}}
2. **No `obsidian` imports in test files** — Tests use the mock, never the real module.
3. **Settings immutability** — Tests should pass frozen settings and verify no mutations.

## Running Tests

```bash
npm test              # Single run
npm run test:watch    # Watch mode
npm run test:coverage # With coverage report
```

## TDD Workflow for New Features

{{tdd.workflows}}
