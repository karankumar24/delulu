// delulu engine — the public API surface itself.
//
// The engine's whole contract with the CLI is this barrel file. A rename or a dropped re-export
// here breaks `handoff` and `resume` at runtime with nothing failing at the unit level, which is
// exactly the shape of break a test file is cheap insurance against.

import { describe, it, expect } from 'vitest';
import * as engine from './index';
import { parseSessionLog } from './tail';
import { mutatedFiles, isMutatingTool } from './files';
import { repoKey } from './repo-key';

describe('engine public API', () => {
  it('re-exports exactly the three questions the CLI asks, and the same functions', () => {
    expect(engine.parseSessionLog).toBe(parseSessionLog);
    expect(engine.mutatedFiles).toBe(mutatedFiles);
    expect(engine.isMutatingTool).toBe(isMutatingTool);
    expect(engine.repoKey).toBe(repoKey);
  });

  it('exposes no runtime surface beyond that', () => {
    // Types are erased, so this is the whole runtime contract. Anything extra appearing here is
    // an accidental export, which is how a private helper becomes something callers depend on.
    expect(Object.keys(engine).sort()).toEqual(['isMutatingCall', 'isMutatingTool', 'mutatedFiles', 'parseSessionLog', 'repoKey']);
  });
});
