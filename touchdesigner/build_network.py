"""
SYNTH//MOTION  ->  TouchDesigner: builds a ready-to-play receiver network.

USAGE (inside TouchDesigner)
  1. Start the bridge on this machine:   npm run bridge
  2. Open Dialogs > Textport and run:
         exec(open('/ABSOLUTE/PATH/TO/synth-motion/touchdesigner/build_network.py').read())
  3. A container  /project1/synthmotion  appears with:
       osc_in     OSC In CHOP  (UDP 7000)  <- hands / audio / beat from the browser
       synth      Null CHOP    (channels named e.g. synthmotion/lead/x - see docs/TOUCHDESIGNER.md)
       viz        a small audio/hand-reactive TOP network (noise -> level -> out)
       ctl_out    OSC Out CHOP (UDP 7001)  -> drives the browser's hue / bloom / pulse
  Open `viz/out` in a viewer, then start the web app and enable "Send to bridge".

STATUS: written against the documented TouchDesigner Python API but NOT executed inside
TouchDesigner by the author of this repo. Every parameter assignment is wrapped so that a
name that differs in your TD build prints a warning instead of aborting the build - please
report anything that warns.
"""

def _set(node, name, value):
    try:
        setattr(node.par, name, value)
    except Exception as e:  # parameter name differs between TD versions
        print('[synthmotion] could not set %s.%s = %r (%s)' % (node.name, name, value, e))


def build(parent_path='/project1'):
    parent = op(parent_path)
    old = parent.op('synthmotion')
    if old:
        old.destroy()
    box = parent.create(baseCOMP, 'synthmotion')

    # ---- receive: browser -> bridge -> OSC/UDP :7000 ---------------------------------------
    osc_in = box.create(oscinCHOP, 'osc_in')
    _set(osc_in, 'port', 7000)
    # Channels arrive named after the OSC address without the leading slash, e.g. synthmotion/lead/x
    synth = box.create(nullCHOP, 'synth')
    synth.inputConnectors[0].connect(osc_in)

    # ---- a small reactive network ----------------------------------------------------------
    viz = box.create(baseCOMP, 'viz')
    noise = viz.create(noiseTOP, 'noise')
    _set(noise, 'resolutionw', 1280)
    _set(noise, 'resolutionh', 720)
    _set(noise, 'outputresolution', 'custom')
    lvl = viz.create(levelTOP, 'level')
    lvl.inputConnectors[0].connect(noise)
    out = viz.create(nullTOP, 'out')
    out.inputConnectors[0].connect(lvl)
    # noise tightens as the lead hand rises; the bass pumps the brightness
    try:
        noise.par.period.expr = "1.5 - 1.2 * (op('../../synth')['synthmotion/lead/y'] or 0.3)"
        lvl.par.opacity.expr = "0.4 + 0.6 * (op('../../synth')['synthmotion/audio/bass'] or 0)"
    except Exception as e:
        print('[synthmotion] could not bind viz expressions (%s)' % e)

    # ---- send back: TD -> OSC/UDP :7001 -> bridge -> browser --------------------------------
    ctl = box.create(constantCHOP, 'ctl')
    ctl.par.name0 = 'synthmotion/control/hue'
    ctl.par.value0.expr = "absTime.seconds * 0.02 % 1"       # slowly cycles the particle hue
    ctl.par.name1 = 'synthmotion/control/bloom'
    ctl.par.value1 = 1.0
    ctl_out = box.create(oscoutCHOP, 'ctl_out')
    ctl_out.inputConnectors[0].connect(ctl)
    _set(ctl_out, 'address', '127.0.0.1')
    _set(ctl_out, 'port', 7001)

    box.nodeX, box.nodeY = 0, 0
    box.layout()
    print('[synthmotion] built %s - open viz/out to see it, and check osc_in for channels.' % box.path)
    return box


build()
