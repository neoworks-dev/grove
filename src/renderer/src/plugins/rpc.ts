// Compatibility shim: RpcEndpoint moved to src/shared/rpc.ts so the main
// process can reuse it for the external app socket. Renderer imports keep
// working through this re-export.

export * from '../../../shared/rpc'
