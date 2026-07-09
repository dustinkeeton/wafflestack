---
name: tdd
description: Test-Driven Development skill. Guides writing tests before implementation — test-first workflow, co-located test files, and boundary mocking. Enforces Red-Green-Refactor cycle.
user-invocable: true
---

# Test-Driven Development (TDD)

When this skill is invoked, follow the TDD workflow below. If invoked with arguments (e.g., `/tdd src/shared/validation.ts`), scope the work to that file or module. If invoked without arguments, audit the codebase for missing test coverage and propose a plan.

## How and when to use

Reach for TDD whenever you are about to change behavior:

- **New source files** — write the test first. Before a new function, class, or module exists, write a failing test that pins the behavior you intend, then implement against it (the Red-Green-Refactor cycle below).
- **Bug fixes** — reproduce before you repair. Write a failing **regression test** that captures the bug first, watch it fail, then fix the code until it passes. The test stays behind as a guard against the bug returning.
- **Refactors** — lean on the existing tests as a safety net. If the code you are about to restructure has no tests, add them first so the refactor is verifiable.

This skill is both **user-invocable** and **agent-granted**:

- **User-invoked** — run `/tdd <path>` to scope the workflow to a file or module (e.g. `/tdd src/shared/validation.ts`), or `/tdd` with no argument to audit the codebase for missing coverage and propose a plan.
- **Agent-granted** — agents that list `tdd` in their `skills:` frontmatter follow this workflow automatically when writing new code or fixing bugs, without an explicit invocation.

## Framework & Structure

- **Test runner:** the project's standard runner — `{{project.testCmd}}` runs the suite
- **Test files:** Co-located next to source as `<name>.test.<ext>` (e.g., `src/shared/validation.test.ts`)
- **Test utilities:** a central test-utils directory (e.g., `src/__test-utils__/`) — mock factories, fixtures, helpers

## Red-Green-Refactor Cycle

When implementing a new function, class, or feature:

1. **RED** — Write a failing test first. Run the runner scoped to that file (most runners accept a path argument) to confirm it fails.
2. **GREEN** — Write the minimum implementation to make the test pass.
3. **REFACTOR** — Clean up both test and production code. Run tests again to confirm they still pass.

Every new source file must have a corresponding test file, unless it is:
- A type-only file (`types.ts`)
- A re-export barrel (`index.ts` that only re-exports)
- A thin UI shell over host-application base classes (test these indirectly through their callers, or extract testable logic into pure functions)

## Test Priority Tiers

{{tdd.priorityTiers}}

## Test Quality Rules

1. **Arrange-Act-Assert** — Every test follows AAA with clear separation.
2. **Descriptive names** — `it('returns null when file is in excluded folder')`, not `it('test 1')`.
3. **One behavior per test** — Multiple assertions OK only when verifying facets of the same behavior.
4. **No test interdependence** — Each test sets up its own fixtures. No shared mutable state.
5. **Mock at the boundary** — Mock external dependencies (network clients, `child_process`, host-application APIs), not internal functions. If you need to mock an internal function, refactor to inject the dependency.
6. **No real API calls** — Tests must never hit real network endpoints. Mock all HTTP.
7. **Security functions get exhaustive coverage** — sanitizers and validators (e.g., `sanitizeUrl`, `sanitizePath`) must test: null bytes, path traversal, shell metacharacters, non-HTTP schemes, XSS vectors, and each pattern the sanitizer strips.

## Mocking Patterns

Examples use Vitest-style APIs (`vi`); adapt to the project's runner.

### Module mocks and factories
Mock host-application or platform modules centrally (a `__mocks__/` directory the runner auto-loads) so every test consumes the same stubs. Keep per-object mock factories in the test-utils directory — fresh instance per test, override-friendly defaults.

### Mocking global `fetch`
```typescript
beforeEach(() => { global.fetch = vi.fn(); });
afterEach(() => { vi.restoreAllMocks(); });
```

### Mocking `child_process`
```typescript
vi.mock('child_process', () => ({
  execFile: vi.fn((cmd, args, opts, cb) => cb(null, '{}', '')),
}));
```

## Architectural Test Rules

1. {{tdd.moduleBoundaries}}
2. **Settings immutability** — Tests should pass frozen settings and verify no mutations.

## Running Tests

```bash
{{project.testCmd}}   # full suite
```

Use the runner's watch and coverage modes during development where available.

## TDD Workflow for New Features

{{tdd.workflows}}
