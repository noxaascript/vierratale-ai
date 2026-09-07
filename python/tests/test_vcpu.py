import unittest

from vierrataleai.vcpu import vcpu
from vierrataleai.vcpu.vram import allocate_pool, reduce
from vierrataleai.vcpu.vgpu import allocate_matrix, matmul


class VCpuFunctionsTest(unittest.TestCase):
    def test_vcpu_set_is_sorted_within_cpu_count(self):
        total = __import__("os").cpu_count() or 8
        cpus = vcpu.vcpu_set()
        self.assertEqual(sorted(cpus), cpus)
        self.assertLessEqual(len(cpus), total)

    def test_n_vcpu_respects_override_and_clamps(self):
        self.assertEqual(vcpu.n_vcpu(4), 4)
        self.assertEqual(vcpu.n_vcpu(10**6), __import__("os").cpu_count() or 8)
        self.assertGreaterEqual(vcpu.n_vcpu(-1), 1)

    def test_parse_mask(self):
        self.assertEqual(vcpu.parse_mask([1, 2, 3]), "1,2,3")


class VramFunctionsTest(unittest.TestCase):
    def test_reduce_runs_and_returns_checksum(self):
        pool = allocate_pool(4)
        total, secs = reduce(pool, threads=2)
        self.assertGreater(secs, 0)
        self.assertGreater(total, 0)


class VgpuFunctionsTest(unittest.TestCase):
    def test_matmul_returns_nonzero_checksum(self):
        a = allocate_matrix(16)
        b = allocate_matrix(16)
        checksum, secs = matmul(a, b, 16, threads=2)
        self.assertGreater(secs, 0)
        self.assertGreater(checksum, 0)


if __name__ == "__main__":
    unittest.main()