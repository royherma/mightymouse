import type { JSX } from 'react'
import { useEffect, useRef } from 'react'

export type HideoutOrbState = 'idle' | 'listening' | 'thinking' | 'talking' | 'reacting' | 'paused'

export const ORB_R = 170
const BOX = 2.35
export const ORB_BOX_PX = Math.round(ORB_R * 2 * BOX)
const TAU = Math.PI * 2

export const ORB_STATES: Record<HideoutOrbState, { rgb: [number, number, number]; spin: number }> = {
  idle: { rgb: [95, 212, 240], spin: 0.22 },
  listening: { rgb: [255, 160, 80], spin: 0.45 },
  thinking: { rgb: [180, 150, 255], spin: 2.4 },
  talking: { rgb: [95, 212, 240], spin: 0.6 },
  reacting: { rgb: [77, 187, 122], spin: 0.5 },
  paused: { rgb: [120, 140, 152], spin: 0.06 }
}

const VS = 'attribute vec2 aPos; void main(){ gl_Position = vec4(aPos, 0.0, 1.0); }'
const FS = `
precision highp float;
uniform vec2 uRes;
uniform float uTime, uLevel, uFlash, uBoot, uThink, uPx;
uniform vec3 uColor, uRot;
uniform sampler2D uSpec;
const float BOX = ${BOX.toFixed(2)};
const float TAU = 6.2831853;
vec3 mod289(vec3 x){return x-floor(x*(1./289.))*289.;}
vec4 mod289(vec4 x){return x-floor(x*(1./289.))*289.;}
vec4 permute(vec4 x){return mod289(((x*34.)+1.)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1./6.,1./3.);
  const vec4 D=vec4(0.,.5,1.,2.);
  vec3 i=floor(v+dot(v,C.yyy));
  vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz);
  vec3 l=1.-g;
  vec3 i1=min(g.xyz,l.zxy);
  vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx;
  vec3 x2=x0-i2+C.yyy;
  vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.,i1.z,i2.z,1.))+i.y+vec4(0.,i1.y,i2.y,1.))+i.x+vec4(0.,i1.x,i2.x,1.));
  float n_=.142857142857;
  vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.*floor(p*ns.z*ns.z);
  vec4 x_=floor(j*ns.z);
  vec4 y_=floor(j-7.*x_);
  vec4 x=x_*ns.x+ns.yyyy;
  vec4 y=y_*ns.x+ns.yyyy;
  vec4 h=1.-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy);
  vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.+1.;
  vec4 s1=floor(b1)*2.+1.;
  vec4 sh=-step(h,vec4(0.));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;
  vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x);
  vec3 p1=vec3(a0.zw,h.y);
  vec3 p2=vec3(a1.xy,h.z);
  vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;
  vec4 m=max(.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.);
  m=m*m;
  return 42.*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}
float hash(float n){return fract(sin(n)*43758.5453);}
float band(float d,float r,float hw){return 1.-smoothstep(hw-uPx,hw+uPx,abs(d-r));}
float spec(float a01){return texture2D(uSpec,vec2(1.-abs(a01*2.-1.),.5)).r;}
float seg(float d,float a01,float R,float segs,float gap,float hw,float rot){
  float rr=R*(1.+uLevel*.05);
  float v=fract(fract(a01+rot/TAU)*segs);
  float du=uPx/(rr*TAU)*segs;
  float on=smoothstep(0.,du,v)*(1.-smoothstep(1.-gap-du,1.-gap,v));
  return band(d,rr,hw)*on*step(a01,uBoot);
}
void main(){
  vec2 p=(gl_FragCoord.xy-.5*uRes)/(.5*uRes.x)*BOX;
  float d=length(p);
  if(d>BOX){gl_FragColor=vec4(0.);return;}
  float a=atan(p.x,p.y);
  float a01=fract(a/TAU);
  float t=uTime, L=uLevel, B=uBoot;
  vec3 c=uColor;
  vec3 col=c*(.16+L*.22+uFlash*.3)*exp(-d*d*1.15)*B*(1.-smoothstep(1.9,BOX,d));
  float cr=.5+L*.16+uFlash*.08;
  if(d<cr+.35){
    float k=clamp(d/cr,0.,1.);
    float inside=1.-smoothstep(cr-uPx,cr+uPx,d);
    vec3 q=vec3(p*1.9,t*.22+L*.8);
    float n=snoise(q)*.65+snoise(q*2.3+7.1)*.35;
    float veins=pow(1.-abs(n),7.)*(.45+L*1.6);
    float body=pow(1.-k,1.6);
    col+=inside*(c*(.2+body*.55+veins*.85)+vec3(1.)*pow(1.-k,5.)*.9)*B;
    col+=c*smoothstep(.6,1.,k)*inside*.38*B;
    col+=c*exp(-max(d-cr,0.)*9.)*.32*B*(1.-inside);
  }
  float sp=spec(a01);
  for(int i=0;i<3;i++){
    float fi=float(i);
    float w=sin(a*(3.+fi*2.)+t*(1.3+fi*.8))*.6+sin(a*(7.+fi)-t*(2.1+L*6.))*.4;
    float rr=(.9-fi*.065)*(1.+L*.06)+w*(.012+L*.1)*(1.-fi*.2)+sp*L*.12;
    col+=c*(band(d,rr,.0045*(1.6-fi*.4))*(.85-fi*.2)+exp(-abs(d-rr)*38.)*.08)*B;
  }
  float R0=1.62, N=144.;
  float fa=a01*N, idx=floor(fa), tf=fract(fa)-.5, tc=(idx+.5)/N;
  float s=spec(tc);
  float major=step(mod(idx,12.),.5);
  float len=mix(.035,.085,major)+s*.3;
  float toA=N/(TAU*max(d,.001));
  float hwA=mix(.0045,.0075,major)*toA, pxA=uPx*toA;
  float tick=(1.-smoothstep(hwA-pxA,hwA+pxA,abs(tf)))*smoothstep(R0-uPx,R0+uPx,d)*(1.-smoothstep(R0+len-uPx,R0+len+uPx,d));
  col+=c*tick*(mix(.3,.78,major)+s*.8)*step(tc,B);
  col+=c*band(d,R0-.06,.002)*.22*step(a01,B);
  col+=c*seg(d,a01,1.36,3.,.5,.009,uRot.x)*(.5+L*.3);
  col+=c*seg(d,a01,1.24,24.,.1,.02,uRot.y)*(.14+L*.2);
  col+=c*seg(d,a01,1.12,5.,.22,.005,uRot.z)*(.42+L*.3);
  col+=c*band(d,2.05,.0015)*.09*B;
  col+=c*seg(d,a01,2.05,4.,.94,.004,-uRot.x*.15)*.5;
  col+=c*band(d,1.47,.004)*pow(fract(a01-t*.75),10.)*uThink*1.3;
  float ws=.6+(1.-uFlash)*1.5;
  col+=c*band(d,ws,.008+(1.-uFlash)*.02)*uFlash*.9;
  for(int l=0;l<2;l++){
    float fl=float(l);
    float Np=40.+fl*24.;
    float u=fract(a01+t*(.008+fl*.005)*(fl>.5?-1.:1.))*Np;
    float cell=floor(u);
    float h1=hash(cell*13.7+fl*71.), h2=hash(cell*7.3+fl*19.);
    float off=cell+.2+h2*.6;
    float pr=(1.3+h1*.9)*(1.+L*.12);
    float dist=length(vec2((u-off)/Np*TAU*d,d-pr));
    float size=.006+h2*.006;
    col+=c*(1.-smoothstep(size-uPx,size+uPx,dist))*(.22+h1*.5)*B;
  }
  col=1.-exp(-col*1.25);
  gl_FragColor=vec4(col,max(col.r,max(col.g,col.b)));
}`

const UNIFORMS = ['uRes', 'uTime', 'uLevel', 'uFlash', 'uBoot', 'uThink', 'uPx', 'uColor', 'uRot', 'uSpec'] as const
type Uniforms = Record<(typeof UNIFORMS)[number], WebGLUniformLocation | null>

function initGL(gl: WebGLRenderingContext): Uniforms {
  const sh = (type: number, src: string): WebGLShader => {
    const s = gl.createShader(type) as WebGLShader
    gl.shaderSource(s, src)
    gl.compileShader(s)
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader')
    return s
  }
  const prog = gl.createProgram() as WebGLProgram
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS))
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS))
  gl.linkProgram(prog)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'link')
  gl.useProgram(prog)
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer())
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
  const loc = gl.getAttribLocation(prog, 'aPos')
  gl.enableVertexAttribArray(loc)
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
  const U = Object.fromEntries(UNIFORMS.map((n) => [n, gl.getUniformLocation(prog, n)])) as Uniforms
  gl.bindTexture(gl.TEXTURE_2D, gl.createTexture())
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, 64, 1, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, new Uint8Array(64))
  for (const k of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, k, gl.LINEAR)
  for (const k of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, k, gl.CLAMP_TO_EDGE)
  gl.uniform1i(U.uSpec, 0)
  return U
}

const easeOut = (x: number): number => 1 - Math.pow(1 - x, 3)

export function HideoutOrb({ state, level, scale }: { state: HideoutOrbState; level: number; scale: number }): JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null)
  const aura = useRef<HTMLDivElement>(null)
  const input = useRef({ state, level, scale })
  input.current = { state, level, scale }

  useEffect(() => {
    const cv = canvas.current
    const gl = cv?.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false, powerPreference: 'high-performance' })
    if (!cv || !gl) return
    let U: Uniforms
    try {
      U = initGL(gl)
    } catch (e) {
      console.error('hideout orb:', e)
      return
    }
    const st = { rgb: [...ORB_STATES.idle.rgb], level: 0, flash: 0, boot: 0, think: 0, spin: 0.22, rot: [0, 0, 0], was: 'idle' }
    const specBytes = new Uint8Array(64)
    const specF = new Float32Array(64)
    let clock = 0
    let last = performance.now()
    let raf = 0
    const frame = (now: number): void => {
      raf = requestAnimationFrame(frame)
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      clock += dt
      const { state: s, level: lv, scale: k } = input.current
      const S = ORB_STATES[s]
      if (s === 'reacting' && st.was !== 'reacting') st.flash = 1
      st.was = s
      for (let i = 0; i < 3; i++) st.rgb[i] += (S.rgb[i] - st.rgb[i]) * Math.min(1, dt * 5)
      st.spin += (S.spin - st.spin) * Math.min(1, dt * 2.5)
      st.rot[0] = (st.rot[0] + st.spin * dt) % TAU
      st.rot[1] = (st.rot[1] - st.spin * 0.6 * dt) % TAU
      st.rot[2] = (st.rot[2] + st.spin * 1.7 * dt) % TAU
      st.think += ((s === 'thinking' ? 1 : 0) - st.think) * Math.min(1, dt * 4)
      st.flash = Math.max(0, st.flash - dt * 1.3)
      st.boot = Math.min(1, st.boot + dt / 2.2)
      let target = s === 'paused' ? 0.02 : 0.05 + Math.sin(clock * 1.3) * 0.025
      if (s === 'thinking') target = 0.16 + Math.sin(clock * 5) * 0.04
      if (s === 'talking') target = 0.12 + lv * 0.7
      if (s === 'listening') target = Math.max(0.12, lv)
      st.level += (target - st.level) * Math.min(1, dt * (target > st.level ? 18 : 7))
      for (let i = 0; i < 64; i++) {
        const v = st.level * (0.35 + 0.65 * Math.abs(Math.sin(i * 0.61 + clock * (2 + st.level * 8)) * Math.cos(i * 0.23 - clock * 1.7)))
        specF[i] += (v - specF[i]) * Math.min(1, dt * (v > specF[i] ? 30 : 6))
        specBytes[i] = specF[i] * 255
      }
      if (aura.current) {
        aura.current.style.opacity = ((0.08 + st.level * 0.14 + st.flash * 0.2) * easeOut(st.boot)).toFixed(2)
        aura.current.style.color = `rgb(${st.rgb.map(Math.round).join(',')})`
      }
      const px = Math.round(Math.min(ORB_BOX_PX * k * Math.min(devicePixelRatio || 1, 2), 1400))
      if (cv.width !== px) {
        cv.width = px
        cv.height = px
      }
      gl.viewport(0, 0, cv.width, cv.height)
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 64, 1, gl.LUMINANCE, gl.UNSIGNED_BYTE, specBytes)
      gl.uniform2f(U.uRes, cv.width, cv.height)
      gl.uniform1f(U.uTime, clock % 3600)
      gl.uniform1f(U.uLevel, st.level)
      gl.uniform1f(U.uFlash, st.flash)
      gl.uniform1f(U.uBoot, easeOut(st.boot))
      gl.uniform1f(U.uThink, st.think)
      gl.uniform1f(U.uPx, (2 * BOX) / cv.width)
      gl.uniform3f(U.uColor, st.rgb[0] / 255, st.rgb[1] / 255, st.rgb[2] / 255)
      gl.uniform3f(U.uRot, st.rot[0], st.rot[1], st.rot[2])
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <>
      <div ref={aura} className="aura" />
      <canvas ref={canvas} className="orb" />
    </>
  )
}
