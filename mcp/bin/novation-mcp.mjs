#!/usr/bin/env node
// Starts the Novation MCP server over stdio. Runs the TypeScript sources directly through tsx.
import { register } from 'tsx/esm/api';

register();
await import('../src/cli.ts');
