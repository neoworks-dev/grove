// Re-export shim: the RpcEndpoint lives in the SDK package (sdk/src/rpc.ts)
// so the published node client and the host share one implementation.

export * from '../../sdk/src/rpc'
