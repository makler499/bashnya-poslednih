import { createRequire } from 'node:module';
import { cpSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoArt = fileURLToPath(new URL('../map-art/', import.meta.url));
const bundledArt = fileURLToPath(new URL('./public/map-art/', import.meta.url));

export default {
  resolve: {
    alias: [{ find: /^events$/, replacement: require.resolve('events/') }],
  },
  plugins: [{
    name: 'copy-map-art-from-repository',
    apply: 'build',
    closeBundle() {
      if (existsSync(bundledArt)) return;
      if (!existsSync(repoArt)) throw new Error('Missing map-art directory');
      cpSync(repoArt, fileURLToPath(new URL('./dist/map-art/', import.meta.url)), { recursive: true });
    },
  }],
};
