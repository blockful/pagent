if (process.env.NODE_ENV !== 'production' && process.env.CI !== 'true') {
  const husky = (await import('husky')).default;
  husky();
}
