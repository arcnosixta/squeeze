"""190 generated tests written as real source (no exec), so pytest shows real
function names and readable tracebacks. ~35 of them fail with honest assertion
diffs: the suite is what an agent reads after a bad refactor."""

import random

random.seed(3)

out = ["import pytest", "from calc import discount, shipping", "", ""]

for i in range(150):
    price = round(random.uniform(5, 400), 2)
    pct = random.choice([5, 10, 15, 20, 25])
    broke = random.random() < 0.23
    # The "refactor" started rounding to 2dp before comparing: correct cases
    # pass, ~23% now expect the rounded value and fail with a real diff.
    expected = round(price * (1 - pct / 100), 2) if broke else price * (1 - pct / 100)
    out.append(f"def test_discount_case_{i}():")
    out.append(f"    assert discount({price}, {pct}) == pytest.approx({expected!r}, rel=1e-6)")
    out.append("")

for i in range(40):
    w = round(random.uniform(0.1, 12), 1)
    express = random.choice([True, False])
    exact = (4.99 + 1.75 * w) * (2 if express else 1)
    broke = random.random() < 0.2
    expected = exact * 1.05 if broke else exact
    out.append(f"def test_shipping_case_{i}():")
    out.append(f"    assert shipping({w}, express={express}) == pytest.approx({expected!r}, rel=1e-6)")
    out.append("")

print("\n".join(out))