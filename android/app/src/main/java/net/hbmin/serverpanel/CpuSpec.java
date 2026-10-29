package net.hbmin.serverpanel;

/**
 * CPU 规格（物理核 / 逻辑线程）。
 *
 * 纯逻辑，可被 JDK 单测直接编译验证；所有数字都来自接口
 * （/api/metrics/latest 的 cpu.threads / cpu.threadsPerCore / cpu.coreCount，
 *  或 /api/system 的 cpuCores / cpuPhysicalCores），不硬编码。
 */
final class CpuSpec {

    final int physical;
    final int threads;

    private CpuSpec(int physical, int threads) {
        this.physical = physical;
        this.threads = threads;
    }

    /** 物理核与线程数都有效（>0 且 threads >= physical）才返回对象；否则 null。 */
    static CpuSpec of(int physical, int threads) {
        if (physical <= 0 || threads <= 0 || threads < physical) return null;
        return new CpuSpec(physical, threads);
    }

    /** 只知道逻辑线程数与每核线程数时推导物理核（如 16 线程 / 每核 2 = 8 核）。 */
    static CpuSpec fromThreadsPerCore(int threads, int threadsPerCore) {
        if (threads <= 0 || threadsPerCore <= 0) return null;
        return of(threads / threadsPerCore, threads);
    }

    boolean hyperThreading() {
        return threads > physical;
    }

    /** 紧凑标签：超线程 8C/16T，无超线程 8C/8T。 */
    String shortLabel() {
        return physical + "C/" + threads + "T";
    }
}
