import type { NextConfig } from "next"

const isDockerBuild = process.env.DBACKUP_DOCKER_BUILD === "1"

const dockerBuildConfig = {
  serverExternalPackages: [
    "@aws-sdk/lib-storage",
    "@microsoft/microsoft-graph-client",
    "dockerode",
    "dropbox",
    "googleapis",
    "mssql",
    "ssh2",
    "ssh2-sftp-client",
  ],
  experimental: {
    cpus: 1,
    webpackBuildWorker: true,
    webpackMemoryOptimizations: true,
  },
  outputFileTracingIncludes: {
    "/*": ["node_modules/sharp/**/*"],
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  webpack(config, { dev, isServer, webpack }) {
    if (!dev && config.cache && typeof config.cache === "object") {
      config.cache = {
        ...config.cache,
        maxMemoryGenerations: 0,
      }
    }

    if (!isServer) {
      config.plugins.push(
        new webpack.NormalModuleReplacementPlugin(/^node:crypto$/, "crypto"),
      )
    }

    return config
  },
} satisfies NextConfig

const nextConfig: NextConfig = {
  output: "standalone",
  ...(isDockerBuild ? dockerBuildConfig : {}),
}

export default nextConfig
