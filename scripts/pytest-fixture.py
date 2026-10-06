"""A deliberately fragile cart module. A refactor introduced the rounding bugs
and the broken express/weight rules that scripts/collect-real.sh turns into a
real pytest traceback."""

def discount(price: float, pct: int) -> float:
    if pct > 100:
        raise ValueError("pct out of range")
    return price * (1 - pct / 100)


def total(prices):
    return sum(prices)


def tax(amount: float, rate: float) -> float:
    return amount * rate


def shipping(weight_kg: float, express: bool) -> float:
    base = 4.99 + 1.75 * weight_kg
    return base * 2 if express else base