#!/usr/bin/env node
import { sampleFseventsdRss, fseventsdThresholds } from '../lib/fseventsd-rss.mjs';
try {
  const thresholds = fseventsdThresholds();
  console.log(JSON.stringify({ rssMb: sampleFseventsdRss(), ...thresholds }));
} catch (error) {
  console.log(JSON.stringify({ rssMb: null, error: error.message }));
  process.exitCode = 1;
}
