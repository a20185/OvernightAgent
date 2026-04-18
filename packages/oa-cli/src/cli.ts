#!/usr/bin/env node
import { Command } from 'commander';
import pkg from '../package.json' with { type: 'json' };

const program = new Command();

program.name('oa').version(pkg.version).parse(process.argv);
