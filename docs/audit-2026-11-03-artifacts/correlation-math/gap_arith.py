# lag_hours = lag_samples*4 vs the true clock offset on a 4h grid with gaps.
# The real CSV is absent; the Methods page says 128 samples, 27 May - 18 June 2021,
# ~4h cadence with "a few gaps of 8-12 h". 27 May 00:00 -> 18 June 20:00 is ~133 slots,
# so ~5 slots are missing. Representative placements below; report, per lag k, the
# share of contributing pairs whose true offset != 4k and the worst-case offset.
import itertools, numpy as np
def analyse(missing_slots, n_slots=133):
    present = [s for s in range(n_slots) if s not in missing_slots][:128]
    hours = np.array(present) * 4
    out = {}
    for k in range(1, 7):
        true = hours[k:] - hours[:-k]
        out[k] = (float((true != 4 * k).mean()), int(true.max()), sorted(set(true.tolist())))
    return out
cases = {
  'four 8h gaps + one 12h gap, spread':      {20, 45, 46, 70, 95, 120},
  'two 12h gaps + one 8h gap, spread':       {30, 31, 60, 90, 91},
  'five gaps of 8h spread evenly':           {22, 44, 66, 88, 110},
  'two 12h gaps close together':             {60, 61, 64, 65, 100},
}
for name, miss in cases.items():
    print(name)
    for k, (frac, mx, vals) in analyse(miss).items():
        print(f'   lag {k} (shown as {4*k:2d}h): {frac:5.1%} of pairs have a different true offset; offsets seen {vals} h; worst {mx}h')
