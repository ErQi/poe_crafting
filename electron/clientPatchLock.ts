/**
 * Bundles2 的索引和 Bundle 是多个客户端补丁共享的资源。
 * 所有写操作都经过同一个串行队列，避免两个补丁同时从旧索引生成并互相覆盖。
 */
export class ClientPatchLock {
  private tail: Promise<void> = Promise.resolve();

  run<T>(_owner: string, operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
