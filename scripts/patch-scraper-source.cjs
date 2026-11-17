'use strict';
const fs = require('fs');
const path = require('path');

const srcDir = process.argv[2];
if (!srcDir) {
  throw new Error('Usage: node scripts/patch-scraper-source.cjs <path-to-google-maps-scraper-source>');
}

const p = path.join(srcDir, 'runner/resume/results.go');
let s = fs.readFileSync(p, 'utf8');
if (!s.includes('stableURLIDs')) {
  s = s.replace('"strings"', '"strings"\n\t"net/url"\n\t"regexp"');
  const old = '\tif _, ok := s.keys[key]; ok {\n\t\treturn false\n\t}\n\n\ts.keys[key] = struct{}{}\n\n\treturn true';
  const n = '\tidentities := []string{key}\n\tdecoded, err := url.PathUnescape(key)\n\tif err == nil { for _, match := range stableURLIDs.FindAllStringSubmatch(decoded, -1) { identities = append(identities, match[1]) } }\n\tfor _, identity := range identities { if _, ok := s.keys[identity]; ok { return false } }\n\tfor _, identity := range identities { s.keys[identity] = struct{}{} }\n\treturn true';
  if (!s.includes(old)) throw new Error('Source mismatch in runner/resume/results.go');
  s = s.replace(old, n);
  s = s.replace('// IdentitySet tracks', 'var stableURLIDs = regexp.MustCompile("!(?:1s|19s)([^!/?&]+)")\n\n// IdentitySet tracks');
  fs.writeFileSync(p, s);
  console.log('Patched runner/resume/results.go with stable URL PlaceID/CID deduplication.');
}
