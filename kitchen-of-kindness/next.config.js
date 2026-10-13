/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Mail (server routes only): load these from node_modules at runtime
  // instead of bundling them.
  serverExternalPackages: ['imapflow', 'nodemailer', 'mailparser'],
  turbopack: {
    root: __dirname,
  },
};

module.exports = nextConfig;
