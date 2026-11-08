import urllib.parse

# Cork = a light matrix with dark inclusions at several scales. Each layer is
# the SAME construction, only the scale + threshold change:
#   feTurbulence  -> smooth noise in the ALPHA channel (type=fractalNoise)
#   feColorMatrix -> flood the colour to one flat brown, keep noise in alpha
#   feFuncA table -> threshold that smooth alpha into sparse discrete flecks
#
# The threshold is what controls COVERAGE. A table of [0 0 0 1] means "alpha
# below ~0.75 becomes fully transparent, above becomes opaque" -> only the
# top ~25% of the noise field paints, which is what makes flecks SPARSE.
# Pushing more zeros in front makes them sparser still.

def layer(base_freq, octaves, seed, fill, table):
    return (
        '<svg xmlns="http://www.w3.org/2000/svg">'
        '<filter id="f" x="0%" y="0%" width="100%" height="100%" '
        'color-interpolation-filters="sRGB">'
        f'<feTurbulence type="fractalNoise" baseFrequency="{base_freq}" '
        f'numOctaves="{octaves}" seed="{seed}" stitchTiles="stitch" result="n"/>'
        # keep ONLY the alpha channel of the noise; force RGB to the fleck colour
        '<feColorMatrix in="n" type="matrix" values="'
        '0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="a"/>'
        '<feComponentTransfer in="a" result="t">'
        f'<feFuncA type="table" tableValues="{table}"/>'
        '</feComponentTransfer>'
        f'<feFlood flood-color="{fill}" result="c"/>'
        '<feComposite in="c" in2="t" operator="in"/>'
        '</filter>'
        '<rect width="100%" height="100%" filter="url(#f)"/></svg>'
    )

LAYERS = {
    # big irregular voids -- sparse, dark, the largest structure in cork
    'coarse': layer('0.055', 3, 7,  '#33200d', '0 0 0 0 0.55 1'),
    # the readable granule flecks -- the layer that does most of the work
    'mid':    layer('0.16',  4, 19, '#4d3016', '0 0 0 0 0.45 0.95'),
    # fine pepper between granules
    'fine':   layer('0.55',  3, 31, '#63431f', '0 0 0 0.22 0.55'),
    # broad tonal mottling of the base tan (soft, no hard threshold)
    'mottle': layer('0.018', 4, 43, '#8a5c2c', '0 0.12 0.26 0.4'),
}

if __name__ == '__main__':
    for name, svg in LAYERS.items():
        enc = urllib.parse.quote(svg, safe='')
        print(f'--- {name} ({len(enc)} chars) ---')
        print(f'url("data:image/svg+xml,{enc}")')
        print()
