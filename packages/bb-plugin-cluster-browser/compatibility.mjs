// SPDX-License-Identifier: Apache-2.0
/** A patch-line filter, not evidence of behavioral compatibility or authority. */
export function sameReleaseLine(actual, baseline) {
  const parse = value => typeof value === 'string'
    ? /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?![\s\S])/.exec(value)
    : null;
  const a = parse(actual), b = parse(baseline);
  return !!a && !!b && a[1] === b[1] && a[2] === b[2] && Number(a[3]) >= Number(b[3]);
}
