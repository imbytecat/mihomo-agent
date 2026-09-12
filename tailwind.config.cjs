module.exports = {
  content: { relative: true, files: ['./src/**/*.{ts,tsx}'] },
  prefix: 'ufi-',
  important: ':is(#ufi-mihomo, #ufi-mihomo-portals)',
  corePlugins: { preflight: false },
};
