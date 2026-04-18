import { describe, it, expect } from 'vitest';
import * as pkg from '../src/index.js';

describe('smoke', () => {
  it('compiles and exports a module object', () => {
    expect(pkg).toBeDefined();
  });
});
