| cell | render ms | code rows mounted | token spans mounted | DOM nodes | heap MB | fps | p50 | p95 | p99 | max | >16.7ms | longtasks (n / max ms) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| calibration-baseline | 181.1 | 100 | 1188 | 1650 | 26.84 | 120.18 | 8.3 | 9.58 | 10.1 | 10.4 | 0 | 0 / 0 |
| CRUX pierre-virtual / 1 file x 5k | 88.8 | 100 | 1553 | 1956 | 42.28 | 119.69 | 8.3 | 9.65 | 10.2 | 49.6 | 2 | 0 / 0 |
| pierre-codeview / small | 66.3 | 56 | 465 | 744 | 9.74 | 120.67 | 8.3 | 9.5 | 10.28 | 17 | 1 | 0 / 0 |
| pierre-codeview / medium | 73 | 58 | 559 | 828 | 27.11 | 120.1 | 8.3 | 9.8 | 10.2 | 17.1 | 1 | 0 / 0 |
| pierre-codeview / large | 80.8 | 58 | 622 | 899 | 31.48 | 120.05 | 8.3 | 9.7 | 10.2 | 15.4 | 0 | 0 / 0 |
| CRUX pierre-codeview / 1 file x 5k | 75.2 | 57 | 646 | 912 | 35.17 | 119.8 | 8.3 | 9.8 | 10.3 | 33.3 | 1 | 0 / 0 |
| calibration-codeview-stall-50ms | 591.8 | 58 | 559 | 828 | 23.71 | 18.93 | 50.1 | 58.4 | 59.44 | 60.3 | 663 | 664 / 57 |
