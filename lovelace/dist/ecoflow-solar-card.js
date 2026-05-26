var EcoflowSolarCard=function(e){"use strict";function t(e,t,s,o){var i,r=arguments.length,a=r<3?t:null===o?o=Object.getOwnPropertyDescriptor(t,s):o;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)a=Reflect.decorate(e,t,s,o);else for(var n=e.length-1;n>=0;n--)(i=e[n])&&(a=(r<3?i(a):r>3?i(t,s,a):i(t,s))||a);return r>3&&a&&Object.defineProperty(t,s,a),a}"function"==typeof SuppressedError&&SuppressedError;
/**
     * @license
     * Copyright 2019 Google LLC
     * SPDX-License-Identifier: BSD-3-Clause
     */
const s=globalThis,o=s.ShadowRoot&&(void 0===s.ShadyCSS||s.ShadyCSS.nativeShadow)&&"adoptedStyleSheets"in Document.prototype&&"replace"in CSSStyleSheet.prototype,i=Symbol(),r=new WeakMap;let a=class{constructor(e,t,s){if(this._$cssResult$=!0,s!==i)throw Error("CSSResult is not constructable. Use `unsafeCSS` or `css` instead.");this.cssText=e,this.t=t}get styleSheet(){let e=this.o;const t=this.t;if(o&&void 0===e){const s=void 0!==t&&1===t.length;s&&(e=r.get(t)),void 0===e&&((this.o=e=new CSSStyleSheet).replaceSync(this.cssText),s&&r.set(t,e))}return e}toString(){return this.cssText}};const n=(e,...t)=>{const s=1===e.length?e[0]:t.reduce((t,s,o)=>t+(e=>{if(!0===e._$cssResult$)return e.cssText;if("number"==typeof e)return e;throw Error("Value passed to 'css' function must be a 'css' function result: "+e+". Use 'unsafeCSS' to pass non-literal values, but take care to ensure page security.")})(s)+e[o+1],e[0]);return new a(s,e,i)},l=o?e=>e:e=>e instanceof CSSStyleSheet?(e=>{let t="";for(const s of e.cssRules)t+=s.cssText;return(e=>new a("string"==typeof e?e:e+"",void 0,i))(t)})(e):e,{is:c,defineProperty:d,getOwnPropertyDescriptor:h,getOwnPropertyNames:p,getOwnPropertySymbols:u,getPrototypeOf:f}=Object,g=globalThis,v=g.trustedTypes,m=v?v.emptyScript:"",y=g.reactiveElementPolyfillSupport,$=(e,t)=>e,b={toAttribute(e,t){switch(t){case Boolean:e=e?m:null;break;case Object:case Array:e=null==e?e:JSON.stringify(e)}return e},fromAttribute(e,t){let s=e;switch(t){case Boolean:s=null!==e;break;case Number:s=null===e?null:Number(e);break;case Object:case Array:try{s=JSON.parse(e)}catch(e){s=null}}return s}},w=(e,t)=>!c(e,t),x={attribute:!0,type:String,converter:b,reflect:!1,useDefault:!1,hasChanged:w};
/**
     * @license
     * Copyright 2017 Google LLC
     * SPDX-License-Identifier: BSD-3-Clause
     */Symbol.metadata??=Symbol("metadata"),g.litPropertyMetadata??=new WeakMap;let k=class extends HTMLElement{static addInitializer(e){this._$Ei(),(this.l??=[]).push(e)}static get observedAttributes(){return this.finalize(),this._$Eh&&[...this._$Eh.keys()]}static createProperty(e,t=x){if(t.state&&(t.attribute=!1),this._$Ei(),this.prototype.hasOwnProperty(e)&&((t=Object.create(t)).wrapped=!0),this.elementProperties.set(e,t),!t.noAccessor){const s=Symbol(),o=this.getPropertyDescriptor(e,s,t);void 0!==o&&d(this.prototype,e,o)}}static getPropertyDescriptor(e,t,s){const{get:o,set:i}=h(this.prototype,e)??{get(){return this[t]},set(e){this[t]=e}};return{get:o,set(t){const r=o?.call(this);i?.call(this,t),this.requestUpdate(e,r,s)},configurable:!0,enumerable:!0}}static getPropertyOptions(e){return this.elementProperties.get(e)??x}static _$Ei(){if(this.hasOwnProperty($("elementProperties")))return;const e=f(this);e.finalize(),void 0!==e.l&&(this.l=[...e.l]),this.elementProperties=new Map(e.elementProperties)}static finalize(){if(this.hasOwnProperty($("finalized")))return;if(this.finalized=!0,this._$Ei(),this.hasOwnProperty($("properties"))){const e=this.properties,t=[...p(e),...u(e)];for(const s of t)this.createProperty(s,e[s])}const e=this[Symbol.metadata];if(null!==e){const t=litPropertyMetadata.get(e);if(void 0!==t)for(const[e,s]of t)this.elementProperties.set(e,s)}this._$Eh=new Map;for(const[e,t]of this.elementProperties){const s=this._$Eu(e,t);void 0!==s&&this._$Eh.set(s,e)}this.elementStyles=this.finalizeStyles(this.styles)}static finalizeStyles(e){const t=[];if(Array.isArray(e)){const s=new Set(e.flat(1/0).reverse());for(const e of s)t.unshift(l(e))}else void 0!==e&&t.push(l(e));return t}static _$Eu(e,t){const s=t.attribute;return!1===s?void 0:"string"==typeof s?s:"string"==typeof e?e.toLowerCase():void 0}constructor(){super(),this._$Ep=void 0,this.isUpdatePending=!1,this.hasUpdated=!1,this._$Em=null,this._$Ev()}_$Ev(){this._$ES=new Promise(e=>this.enableUpdating=e),this._$AL=new Map,this._$E_(),this.requestUpdate(),this.constructor.l?.forEach(e=>e(this))}addController(e){(this._$EO??=new Set).add(e),void 0!==this.renderRoot&&this.isConnected&&e.hostConnected?.()}removeController(e){this._$EO?.delete(e)}_$E_(){const e=new Map,t=this.constructor.elementProperties;for(const s of t.keys())this.hasOwnProperty(s)&&(e.set(s,this[s]),delete this[s]);e.size>0&&(this._$Ep=e)}createRenderRoot(){const e=this.shadowRoot??this.attachShadow(this.constructor.shadowRootOptions);return((e,t)=>{if(o)e.adoptedStyleSheets=t.map(e=>e instanceof CSSStyleSheet?e:e.styleSheet);else for(const o of t){const t=document.createElement("style"),i=s.litNonce;void 0!==i&&t.setAttribute("nonce",i),t.textContent=o.cssText,e.appendChild(t)}})(e,this.constructor.elementStyles),e}connectedCallback(){this.renderRoot??=this.createRenderRoot(),this.enableUpdating(!0),this._$EO?.forEach(e=>e.hostConnected?.())}enableUpdating(e){}disconnectedCallback(){this._$EO?.forEach(e=>e.hostDisconnected?.())}attributeChangedCallback(e,t,s){this._$AK(e,s)}_$ET(e,t){const s=this.constructor.elementProperties.get(e),o=this.constructor._$Eu(e,s);if(void 0!==o&&!0===s.reflect){const i=(void 0!==s.converter?.toAttribute?s.converter:b).toAttribute(t,s.type);this._$Em=e,null==i?this.removeAttribute(o):this.setAttribute(o,i),this._$Em=null}}_$AK(e,t){const s=this.constructor,o=s._$Eh.get(e);if(void 0!==o&&this._$Em!==o){const e=s.getPropertyOptions(o),i="function"==typeof e.converter?{fromAttribute:e.converter}:void 0!==e.converter?.fromAttribute?e.converter:b;this._$Em=o;const r=i.fromAttribute(t,e.type);this[o]=r??this._$Ej?.get(o)??r,this._$Em=null}}requestUpdate(e,t,s,o=!1,i){if(void 0!==e){const r=this.constructor;if(!1===o&&(i=this[e]),s??=r.getPropertyOptions(e),!((s.hasChanged??w)(i,t)||s.useDefault&&s.reflect&&i===this._$Ej?.get(e)&&!this.hasAttribute(r._$Eu(e,s))))return;this.C(e,t,s)}!1===this.isUpdatePending&&(this._$ES=this._$EP())}C(e,t,{useDefault:s,reflect:o,wrapped:i},r){s&&!(this._$Ej??=new Map).has(e)&&(this._$Ej.set(e,r??t??this[e]),!0!==i||void 0!==r)||(this._$AL.has(e)||(this.hasUpdated||s||(t=void 0),this._$AL.set(e,t)),!0===o&&this._$Em!==e&&(this._$Eq??=new Set).add(e))}async _$EP(){this.isUpdatePending=!0;try{await this._$ES}catch(e){Promise.reject(e)}const e=this.scheduleUpdate();return null!=e&&await e,!this.isUpdatePending}scheduleUpdate(){return this.performUpdate()}performUpdate(){if(!this.isUpdatePending)return;if(!this.hasUpdated){if(this.renderRoot??=this.createRenderRoot(),this._$Ep){for(const[e,t]of this._$Ep)this[e]=t;this._$Ep=void 0}const e=this.constructor.elementProperties;if(e.size>0)for(const[t,s]of e){const{wrapped:e}=s,o=this[t];!0!==e||this._$AL.has(t)||void 0===o||this.C(t,void 0,s,o)}}let e=!1;const t=this._$AL;try{e=this.shouldUpdate(t),e?(this.willUpdate(t),this._$EO?.forEach(e=>e.hostUpdate?.()),this.update(t)):this._$EM()}catch(t){throw e=!1,this._$EM(),t}e&&this._$AE(t)}willUpdate(e){}_$AE(e){this._$EO?.forEach(e=>e.hostUpdated?.()),this.hasUpdated||(this.hasUpdated=!0,this.firstUpdated(e)),this.updated(e)}_$EM(){this._$AL=new Map,this.isUpdatePending=!1}get updateComplete(){return this.getUpdateComplete()}getUpdateComplete(){return this._$ES}shouldUpdate(e){return!0}update(e){this._$Eq&&=this._$Eq.forEach(e=>this._$ET(e,this[e])),this._$EM()}updated(e){}firstUpdated(e){}};k.elementStyles=[],k.shadowRootOptions={mode:"open"},k[$("elementProperties")]=new Map,k[$("finalized")]=new Map,y?.({ReactiveElement:k}),(g.reactiveElementVersions??=[]).push("2.1.2");
/**
     * @license
     * Copyright 2017 Google LLC
     * SPDX-License-Identifier: BSD-3-Clause
     */
const _=globalThis,A=e=>e,S=_.trustedTypes,P=S?S.createPolicy("lit-html",{createHTML:e=>e}):void 0,E="$lit$",C=`lit$${Math.random().toFixed(9).slice(2)}$`,T="?"+C,H=`<${T}>`,M=document,j=()=>M.createComment(""),L=e=>null===e||"object"!=typeof e&&"function"!=typeof e,O=Array.isArray,W="[ \t\n\f\r]",U=/<(?:(!--|\/[^a-zA-Z])|(\/?[a-zA-Z][^>\s]*)|(\/?$))/g,z=/-->/g,R=/>/g,N=RegExp(`>|${W}(?:([^\\s"'>=/]+)(${W}*=${W}*(?:[^ \t\n\f\r"'\`<>=]|("|')|))|$)`,"g"),F=/'/g,D=/"/g,V=/^(?:script|style|textarea|title)$/i,I=e=>(t,...s)=>({_$litType$:e,strings:t,values:s}),B=I(1),q=I(2),K=Symbol.for("lit-noChange"),Z=Symbol.for("lit-nothing"),J=new WeakMap,G=M.createTreeWalker(M,129);function Q(e,t){if(!O(e)||!e.hasOwnProperty("raw"))throw Error("invalid template strings array");return void 0!==P?P.createHTML(t):t}const X=(e,t)=>{const s=e.length-1,o=[];let i,r=2===t?"<svg>":3===t?"<math>":"",a=U;for(let t=0;t<s;t++){const s=e[t];let n,l,c=-1,d=0;for(;d<s.length&&(a.lastIndex=d,l=a.exec(s),null!==l);)d=a.lastIndex,a===U?"!--"===l[1]?a=z:void 0!==l[1]?a=R:void 0!==l[2]?(V.test(l[2])&&(i=RegExp("</"+l[2],"g")),a=N):void 0!==l[3]&&(a=N):a===N?">"===l[0]?(a=i??U,c=-1):void 0===l[1]?c=-2:(c=a.lastIndex-l[2].length,n=l[1],a=void 0===l[3]?N:'"'===l[3]?D:F):a===D||a===F?a=N:a===z||a===R?a=U:(a=N,i=void 0);const h=a===N&&e[t+1].startsWith("/>")?" ":"";r+=a===U?s+H:c>=0?(o.push(n),s.slice(0,c)+E+s.slice(c)+C+h):s+C+(-2===c?t:h)}return[Q(e,r+(e[s]||"<?>")+(2===t?"</svg>":3===t?"</math>":"")),o]};class Y{constructor({strings:e,_$litType$:t},s){let o;this.parts=[];let i=0,r=0;const a=e.length-1,n=this.parts,[l,c]=X(e,t);if(this.el=Y.createElement(l,s),G.currentNode=this.el.content,2===t||3===t){const e=this.el.content.firstChild;e.replaceWith(...e.childNodes)}for(;null!==(o=G.nextNode())&&n.length<a;){if(1===o.nodeType){if(o.hasAttributes())for(const e of o.getAttributeNames())if(e.endsWith(E)){const t=c[r++],s=o.getAttribute(e).split(C),a=/([.?@])?(.*)/.exec(t);n.push({type:1,index:i,name:a[2],strings:s,ctor:"."===a[1]?ie:"?"===a[1]?re:"@"===a[1]?ae:oe}),o.removeAttribute(e)}else e.startsWith(C)&&(n.push({type:6,index:i}),o.removeAttribute(e));if(V.test(o.tagName)){const e=o.textContent.split(C),t=e.length-1;if(t>0){o.textContent=S?S.emptyScript:"";for(let s=0;s<t;s++)o.append(e[s],j()),G.nextNode(),n.push({type:2,index:++i});o.append(e[t],j())}}}else if(8===o.nodeType)if(o.data===T)n.push({type:2,index:i});else{let e=-1;for(;-1!==(e=o.data.indexOf(C,e+1));)n.push({type:7,index:i}),e+=C.length-1}i++}}static createElement(e,t){const s=M.createElement("template");return s.innerHTML=e,s}}function ee(e,t,s=e,o){if(t===K)return t;let i=void 0!==o?s._$Co?.[o]:s._$Cl;const r=L(t)?void 0:t._$litDirective$;return i?.constructor!==r&&(i?._$AO?.(!1),void 0===r?i=void 0:(i=new r(e),i._$AT(e,s,o)),void 0!==o?(s._$Co??=[])[o]=i:s._$Cl=i),void 0!==i&&(t=ee(e,i._$AS(e,t.values),i,o)),t}class te{constructor(e,t){this._$AV=[],this._$AN=void 0,this._$AD=e,this._$AM=t}get parentNode(){return this._$AM.parentNode}get _$AU(){return this._$AM._$AU}u(e){const{el:{content:t},parts:s}=this._$AD,o=(e?.creationScope??M).importNode(t,!0);G.currentNode=o;let i=G.nextNode(),r=0,a=0,n=s[0];for(;void 0!==n;){if(r===n.index){let t;2===n.type?t=new se(i,i.nextSibling,this,e):1===n.type?t=new n.ctor(i,n.name,n.strings,this,e):6===n.type&&(t=new ne(i,this,e)),this._$AV.push(t),n=s[++a]}r!==n?.index&&(i=G.nextNode(),r++)}return G.currentNode=M,o}p(e){let t=0;for(const s of this._$AV)void 0!==s&&(void 0!==s.strings?(s._$AI(e,s,t),t+=s.strings.length-2):s._$AI(e[t])),t++}}class se{get _$AU(){return this._$AM?._$AU??this._$Cv}constructor(e,t,s,o){this.type=2,this._$AH=Z,this._$AN=void 0,this._$AA=e,this._$AB=t,this._$AM=s,this.options=o,this._$Cv=o?.isConnected??!0}get parentNode(){let e=this._$AA.parentNode;const t=this._$AM;return void 0!==t&&11===e?.nodeType&&(e=t.parentNode),e}get startNode(){return this._$AA}get endNode(){return this._$AB}_$AI(e,t=this){e=ee(this,e,t),L(e)?e===Z||null==e||""===e?(this._$AH!==Z&&this._$AR(),this._$AH=Z):e!==this._$AH&&e!==K&&this._(e):void 0!==e._$litType$?this.$(e):void 0!==e.nodeType?this.T(e):(e=>O(e)||"function"==typeof e?.[Symbol.iterator])(e)?this.k(e):this._(e)}O(e){return this._$AA.parentNode.insertBefore(e,this._$AB)}T(e){this._$AH!==e&&(this._$AR(),this._$AH=this.O(e))}_(e){this._$AH!==Z&&L(this._$AH)?this._$AA.nextSibling.data=e:this.T(M.createTextNode(e)),this._$AH=e}$(e){const{values:t,_$litType$:s}=e,o="number"==typeof s?this._$AC(e):(void 0===s.el&&(s.el=Y.createElement(Q(s.h,s.h[0]),this.options)),s);if(this._$AH?._$AD===o)this._$AH.p(t);else{const e=new te(o,this),s=e.u(this.options);e.p(t),this.T(s),this._$AH=e}}_$AC(e){let t=J.get(e.strings);return void 0===t&&J.set(e.strings,t=new Y(e)),t}k(e){O(this._$AH)||(this._$AH=[],this._$AR());const t=this._$AH;let s,o=0;for(const i of e)o===t.length?t.push(s=new se(this.O(j()),this.O(j()),this,this.options)):s=t[o],s._$AI(i),o++;o<t.length&&(this._$AR(s&&s._$AB.nextSibling,o),t.length=o)}_$AR(e=this._$AA.nextSibling,t){for(this._$AP?.(!1,!0,t);e!==this._$AB;){const t=A(e).nextSibling;A(e).remove(),e=t}}setConnected(e){void 0===this._$AM&&(this._$Cv=e,this._$AP?.(e))}}class oe{get tagName(){return this.element.tagName}get _$AU(){return this._$AM._$AU}constructor(e,t,s,o,i){this.type=1,this._$AH=Z,this._$AN=void 0,this.element=e,this.name=t,this._$AM=o,this.options=i,s.length>2||""!==s[0]||""!==s[1]?(this._$AH=Array(s.length-1).fill(new String),this.strings=s):this._$AH=Z}_$AI(e,t=this,s,o){const i=this.strings;let r=!1;if(void 0===i)e=ee(this,e,t,0),r=!L(e)||e!==this._$AH&&e!==K,r&&(this._$AH=e);else{const o=e;let a,n;for(e=i[0],a=0;a<i.length-1;a++)n=ee(this,o[s+a],t,a),n===K&&(n=this._$AH[a]),r||=!L(n)||n!==this._$AH[a],n===Z?e=Z:e!==Z&&(e+=(n??"")+i[a+1]),this._$AH[a]=n}r&&!o&&this.j(e)}j(e){e===Z?this.element.removeAttribute(this.name):this.element.setAttribute(this.name,e??"")}}class ie extends oe{constructor(){super(...arguments),this.type=3}j(e){this.element[this.name]=e===Z?void 0:e}}class re extends oe{constructor(){super(...arguments),this.type=4}j(e){this.element.toggleAttribute(this.name,!!e&&e!==Z)}}class ae extends oe{constructor(e,t,s,o,i){super(e,t,s,o,i),this.type=5}_$AI(e,t=this){if((e=ee(this,e,t,0)??Z)===K)return;const s=this._$AH,o=e===Z&&s!==Z||e.capture!==s.capture||e.once!==s.once||e.passive!==s.passive,i=e!==Z&&(s===Z||o);o&&this.element.removeEventListener(this.name,this,s),i&&this.element.addEventListener(this.name,this,e),this._$AH=e}handleEvent(e){"function"==typeof this._$AH?this._$AH.call(this.options?.host??this.element,e):this._$AH.handleEvent(e)}}class ne{constructor(e,t,s){this.element=e,this.type=6,this._$AN=void 0,this._$AM=t,this.options=s}get _$AU(){return this._$AM._$AU}_$AI(e){ee(this,e)}}const le=_.litHtmlPolyfillSupport;le?.(Y,se),(_.litHtmlVersions??=[]).push("3.3.3");const ce=globalThis;
/**
     * @license
     * Copyright 2017 Google LLC
     * SPDX-License-Identifier: BSD-3-Clause
     */class de extends k{constructor(){super(...arguments),this.renderOptions={host:this},this._$Do=void 0}createRenderRoot(){const e=super.createRenderRoot();return this.renderOptions.renderBefore??=e.firstChild,e}update(e){const t=this.render();this.hasUpdated||(this.renderOptions.isConnected=this.isConnected),super.update(e),this._$Do=((e,t,s)=>{const o=s?.renderBefore??t;let i=o._$litPart$;if(void 0===i){const e=s?.renderBefore??null;o._$litPart$=i=new se(t.insertBefore(j(),e),e,void 0,s??{})}return i._$AI(e),i})(t,this.renderRoot,this.renderOptions)}connectedCallback(){super.connectedCallback(),this._$Do?.setConnected(!0)}disconnectedCallback(){super.disconnectedCallback(),this._$Do?.setConnected(!1)}render(){return K}}de._$litElement$=!0,de.finalized=!0,ce.litElementHydrateSupport?.({LitElement:de});const he=ce.litElementPolyfillSupport;he?.({LitElement:de}),(ce.litElementVersions??=[]).push("4.2.2");
/**
     * @license
     * Copyright 2017 Google LLC
     * SPDX-License-Identifier: BSD-3-Clause
     */
const pe=e=>(t,s)=>{void 0!==s?s.addInitializer(()=>{customElements.define(e,t)}):customElements.define(e,t)},ue={attribute:!0,type:String,converter:b,reflect:!1,hasChanged:w},fe=(e=ue,t,s)=>{const{kind:o,metadata:i}=s;let r=globalThis.litPropertyMetadata.get(i);if(void 0===r&&globalThis.litPropertyMetadata.set(i,r=new Map),"setter"===o&&((e=Object.create(e)).wrapped=!0),r.set(s.name,e),"accessor"===o){const{name:o}=s;return{set(s){const i=t.get.call(this);t.set.call(this,s),this.requestUpdate(o,i,e,!0,s)},init(t){return void 0!==t&&this.C(o,void 0,e,t),t}}}if("setter"===o){const{name:o}=s;return function(s){const i=this[o];t.call(this,s),this.requestUpdate(o,i,e,!0,s)}}throw Error("Unsupported decorator location: "+o)};
/**
     * @license
     * Copyright 2017 Google LLC
     * SPDX-License-Identifier: BSD-3-Clause
     */function ge(e){return(t,s)=>"object"==typeof s?fe(e,t,s):((e,t,s)=>{const o=t.hasOwnProperty(s);return t.constructor.createProperty(s,e),o?Object.getOwnPropertyDescriptor(t,s):void 0})(e,t,s)}
/**
     * @license
     * Copyright 2017 Google LLC
     * SPDX-License-Identifier: BSD-3-Clause
     */function ve(e){return ge({...e,state:!0,attribute:!1})}const me=new Map,ye=[1e3,2e3,4e3,8e3,16e3,3e4];function $e(e,t={}){const s=t.wsCtor??("undefined"!=typeof WebSocket?WebSocket:void 0),o=t.fetchImpl??("undefined"!=typeof fetch?fetch:void 0);let i=null,r="idle",a=null,n=0,l=null,c=null,d=!1,h=!1;const p=new Set,u=()=>{for(const e of p)try{e(i)}catch(e){"undefined"!=typeof console&&console.warn("[ecoflow] snapshot subscriber threw",e)}},f=e=>{r!==e&&(r=e,u())},g=()=>{null!=l&&(clearTimeout(l),l=null)},v=()=>{null!=c&&(clearTimeout(c),c=null)},m=()=>{if(g(),a){a.onopen=null,a.onmessage=null,a.onerror=null,a.onclose=null;try{a.close()}catch{}a=null}},y=()=>{if(d||!s)return;let t;g(),f("idle"===r?"connecting":"reconnecting");try{t=new s(function(e){let t=e.trim().replace(/\/$/,"");return/^https?:\/\//i.test(t)?t=t.replace(/^http/i,"ws"):/^wss?:\/\//i.test(t)||(t=`ws://${t}`),`${t}/ws`}(e))}catch{return void $()}a=t,t.onopen=()=>{d||a!==t||(n=0,f("open"),(()=>{if(h||!o)return;h=!0;const t=function(e,t){let s=e.trim().replace(/\/$/,"");return/^wss?:\/\//i.test(s)?s=s.replace(/^ws/i,"http"):/^https?:\/\//i.test(s)||(s=`http://${s}`),`${s}${t.startsWith("/")?t:`/${t}`}`}(e,"/api/snapshot");o(t).then(e=>e.ok?e.json():null).then(e=>{!d&&e&&null==i&&(i=e,u())}).catch(()=>{})})())},t.onmessage=e=>{if(!d&&a===t)try{const t=JSON.parse("string"==typeof e.data?e.data:"");t&&"snapshot"===t.type&&t.data&&(i=t.data,u())}catch{}},t.onerror=()=>{},t.onclose=()=>{a===t&&(a=null,d?f("closed"):$())}},$=()=>{if(d)return;f("reconnecting");const e=Math.min(n,ye.length-1);n+=1,l=setTimeout(()=>{l=null,y()},ye[e])},b={getSnapshot:()=>i,connectionState:()=>r,subscribe(t){v(),p.add(t);try{t(i)}catch(e){"undefined"!=typeof console&&console.warn("[ecoflow] snapshot subscriber threw",e)}return 1===p.size&&null==a&&"open"!==r&&"connecting"!==r&&"reconnecting"!==r&&y(),()=>{p.delete(t)&&0===p.size&&(v(),c=setTimeout(()=>{c=null,0===p.size&&(m(),n=0,h=!1,f("idle"),me.get(e)===b&&me.delete(e))},5e3))}},_destroy(){d=!0,v(),m(),f("closed"),p.clear(),me.get(e)===b&&me.delete(e)}};return b}class be extends de{constructor(){super(...arguments),this.snapshot=null,this.connState="idle",this._unsubscribe=null,this._stateTimer=null}setConfig(e){if(!e)throw new Error("Invalid config");this.config={host:e.host||"http://homeassistant.local:8787",title:e.title||"EcoFlow Panel",refresh_seconds:e.refresh_seconds??30,type:e.type}}effectiveHost(){return this.config?.host||"http://homeassistant.local:8787"}connectedCallback(){super.connectedCallback();const e=function(e){const t=me.get(e);if(t)return t;const s=$e(e);return me.set(e,s),s}(this.effectiveHost());this.connState=e.connectionState(),this._unsubscribe=e.subscribe(t=>{this.snapshot=t,this.connState=e.connectionState()})}disconnectedCallback(){super.disconnectedCallback(),this._unsubscribe&&this._unsubscribe(),this._unsubscribe=null,this._stateTimer&&(clearInterval(this._stateTimer),this._stateTimer=null)}getCardSize(){return 6}}t([ge({attribute:!1})],be.prototype,"config",void 0),t([ve()],be.prototype,"snapshot",void 0),t([ve()],be.prototype,"connState",void 0);const we=n`
  :host {
    --ef-accent: var(--primary-color, #03a9f4);
    --ef-ink: var(--primary-text-color, #212121);
    --ef-muted: var(--secondary-text-color, #757575);
    --ef-panel: var(--card-background-color, #fff);
    --ef-line: var(--divider-color, #e0e0e0);
    --ef-ok: var(--success-color, #4caf50);
    --ef-warn: var(--warning-color, #ff9800);
    --ef-bad: var(--error-color, #f44336);
    --ef-info: var(--info-color, #2196f3);
    --ef-tooltip-bg: var(--ha-card-background, #263238);
    --ef-tooltip-fg: #fff;
  }

  /*
   * Glossary tooltip — keyed off the .ef-glossary spans emitted by the
   * glossary() Lit directive. Because Shadow DOM scopes hide title=
   * attributes from the React-era tooltip path, the new pattern is a
   * pure CSS hover bubble that lives inside the same shadow root as
   * the term it explains.
   */
  .ef-glossary {
    position: relative;
    border-bottom: 1px dotted var(--ef-muted);
    cursor: help;
  }
  .ef-glossary > .ef-tooltip {
    position: absolute;
    bottom: calc(100% + 6px);
    left: 50%;
    transform: translateX(-50%);
    background: var(--ef-tooltip-bg);
    color: var(--ef-tooltip-fg);
    padding: 6px 10px;
    border-radius: 6px;
    font-size: 12px;
    line-height: 1.35;
    white-space: normal;
    max-width: 260px;
    min-width: 160px;
    width: max-content;
    z-index: 100;
    opacity: 0;
    visibility: hidden;
    transition: opacity 120ms ease;
    pointer-events: none;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
  }
  .ef-glossary:hover > .ef-tooltip,
  .ef-glossary:focus-within > .ef-tooltip {
    opacity: 1;
    visibility: visible;
  }
`;function xe(e){const t=e.match(/(\d+)\s*$/);return t?Number(t[1]):null}function ke(e,t){const s=e=>{const t=(e.productName??"").toLowerCase();return t.includes("smart home panel")?0:t.includes("delta pro ultra")?1:t.includes("delta 3 plus")?2:3},o=s(e),i=s(t);if(o!==i)return o-i;if(1===o){const s=xe(e.deviceName),o=xe(t.deviceName);if(null!=s&&null!=o)return s-o;if(null!=s)return-1;if(null!=o)return 1}return e.deviceName.localeCompare(t.deviceName)}const _e=e=>null==e?"—":Math.abs(e)>=1e3?`${(e/1e3).toFixed(2)} kW`:`${Math.round(e)} W`,Ae={};function Se(e,t){for(const s of e.split("|"))Ae[s.trim()]=t}function Pe(e){const t=function(e){const t=function(e){return e.split("·")[0].split("(")[0].replace(/\s+/g," ").trim().toLowerCase()}(e);return t?Ae[t]:void 0}(e);return t?B`<span class="ef-glossary"
    >${e}<span class="ef-tooltip" role="tooltip">${t}</span></span
  >`:e}function Ee(e,t,s,o){const i=t-e||1,r=o-s;return t=>s+(t-e)/i*r}function Ce(e,t,s){const o=[];let i=!1;for(const r of e){if(null==r.value||!Number.isFinite(r.value)){i=!1;continue}const e=t(r.ts),a=s(r.value);o.push(`${i?"L":"M"} ${e.toFixed(1)} ${a.toFixed(1)}`),i=!0}return o.join(" ")}function Te(e,t={}){const s=t.width??720,o=t.height??220,i=36,r=10,a=s-i-36,n=o-r-22,l=[...e.area?.points??[],...e.line?.points??[],...e.rightLine?.points??[]];if(l.length<2)return B`<div style="height:${o}px;color:var(--ef-muted);font-size:11px;display:flex;align-items:center;justify-content:center;">no forecast data</div>`;const c=l.map(e=>e.ts),d=Math.min(...c),h=Math.max(...c),p=[];e.area&&p.push(...e.area.points.map(e=>e.value).filter(e=>null!=e)),e.line&&p.push(...e.line.points.map(e=>e.value).filter(e=>null!=e));const u=t.yMax??1.05*Math.max(100,...p),f=Math.min(0,...p),g=Ee(d,h,i,i+a),v=Ee(f,u,r+n,r),m=Ee(0,100,r+n,r),y=v(0),$=216e5,b=[];for(let e=Math.ceil(d/$)*$;e<=h;e+=$){const t=g(e);b.push(q`<line x1=${t} x2=${t} y1=${r} y2=${r+n} stroke="var(--ef-line)" stroke-dasharray="2 3" stroke-opacity=".6" />`)}const w=[0,u/2,u].map(e=>({v:e,y:v(e)})),x=[0,50,100].map(e=>({v:e,y:m(e)})),k=e.area?function(e,t,s,o){const i=Ce(e,t,s);if(!i)return"";let r=null,a=null;for(const s of e)if(null!=s.value&&Number.isFinite(s.value)){const e=t(s.ts);null==r&&(r=e),a=e}return null==r||null==a?"":`${i} L ${a.toFixed(1)} ${o.toFixed(1)} L ${r.toFixed(1)} ${o.toFixed(1)} Z`}(e.area.points,g,v,y):"",_=e.line?Ce(e.line.points,g,v):"",A=e.rightLine?Ce(e.rightLine.points,g,m):"",S=e.rightRef?m(e.rightRef.value):null,P="display:inline-block;width:14px;height:2px;margin-right:4px;vertical-align:middle",E=B`<div style="display:flex;flex-wrap:wrap;gap:10px;font-size:11px;color:var(--ef-muted);margin-top:4px;">${e.area?.label?B`<span><span style="${"display:inline-block;width:10px;height:10px;opacity:.6;border-radius:2px;margin-right:4px"};background:${e.area.color};"></span>${e.area.label}</span>`:null}${e.line?.label?B`<span><span style="${P};background:${e.line.color};"></span>${e.line.label}</span>`:null}${e.rightLine?.label?B`<span><span style="${P};background:${e.rightLine.color};"></span>${e.rightLine.label}</span>`:null}</div>`;return B`<svg viewBox="0 0 ${s} ${o}" width="100%" height=${o} preserveAspectRatio="none" aria-hidden="true">${b}${w.map(e=>q`<line x1=${i} x2=${i+a} y1=${e.y} y2=${e.y} stroke="var(--ef-line)" stroke-opacity=".4" /><text x=${32} y=${e.y+3} text-anchor="end" font-size="9" fill="var(--ef-muted)">${(e.v/1e3).toFixed(1)}k</text>`)}${x.map(e=>q`<text x=${i+a+4} y=${e.y+3} text-anchor="start" font-size="9" fill="var(--ef-muted)">${e.v.toFixed(0)}%</text>`)}${null!=S?q`<line x1=${i} x2=${i+a} y1=${S} y2=${S} stroke=${e.rightRef.color} stroke-dasharray="4 4" stroke-opacity=".7" />`:null}${k?q`<path d=${k} fill=${e.area.color} fill-opacity=".35" stroke="none" />`:null}${_?q`<path d=${_} fill="none" stroke=${e.line.color} stroke-width="1.6" />`:null}${A?q`<path d=${A} fill="none" stroke=${e.rightLine.color} stroke-width="2" />`:null}</svg>${E}`}Se("soc|state of charge","State of charge — how full the battery is right now, 0–100%."),Se("avg soc","Average state of charge across every online battery pack in the fleet."),Se("soh|state of health|avg soh","State of health — measured usable capacity vs the pack’s original design capacity. A wear gauge; 100% = like-new."),Se("ocv|open-circuit","Open-circuit voltage — the pack’s resting voltage with no load applied."),Se("cell spread|worst cell spread|cell imbalance|cell spread now","Cell-voltage spread — the gap between the highest and lowest cell in a pack. A widening gap is an early sign of imbalance."),Se("cell mean","Average voltage across all of the pack’s cells."),Se("pack volt","Pack terminal voltage."),Se("rep temp","Representative pack temperature reported by the BMS."),Se("cell max|cell min","Hottest / coldest individual cell temperature in the pack."),Se("cell temperatures","Per-cell temperature sensors inside the pack."),Se("cell voltages","Per-cell voltage, each shown with its deviation from the pack mean."),Se("mos max|mosfet temperatures|mosfet temps|mosfet","Power-MOSFET temperature — the BMS switching transistors."),Se("board","BMS circuit-board temperature."),Se("shunt","Current-shunt temperature — the precision resistor the BMS measures pack current across."),Se("ptc heater temperatures|ptc heater temps|ptc","PTC heater temperature — keeps the cells warm enough to charge safely in the cold."),Se("cycles","Equivalent full charge/discharge cycles the pack has completed — a measure of battery age."),Se("lifetime throughput","Total energy ever charged into and discharged out of the pack."),Se("capacity","Energy the battery can store, in kWh."),Se("balancing|cells balancing","The BMS is equalizing cell voltages — routine housekeeping, no action needed."),Se("hottest pack","The warmest pack across the fleet right now."),Se("vitals","The pack’s key live readings at a glance."),Se("pv|pv in|pv total|photovoltaic","Photovoltaic — solar-panel power."),Se("pv high mppt|pv low mppt","Power from one of the DPU’s two solar strings (high- or low-voltage MPPT input)."),Se("ac out|ac output","AC power flowing out of the inverter to your loads."),Se("ac in","AC power flowing into the inverter — grid or generator charging."),Se("ac out freq / v","Inverter AC output frequency (Hz) and voltage."),Se("total in / out","Total power into and out of the DPU across every input and output."),Se("battery v / a","Internal battery-bus voltage and current."),Se("in|out","Power flowing in to / out of the device."),Se("input|output","Power flowing into (charging) or out of (discharging) the pack."),Se("panel load","Total power the SHP2’s circuits are drawing right now."),Se("live contribution|live draw","Power this device is feeding/drawing right now."),Se("voltage|current","Live electrical voltage / current at this input."),Se("v × a","Voltage × current — instantaneous power, shown as a cross-check on the reported watts."),Se("string ω","Effective resistance (volts ÷ amps) at the MPPT string’s operating point."),Se("mppt|mppt temp|mppt hv|mppt lv|hv mppt|lv mppt","MPPT — the solar charge controller (Maximum Power Point Tracker). Each DPU has two: a high-voltage and a low-voltage string input."),Se("hv channels|lv channels","High-/low-voltage MPPT solar string inputs — one of each per DPU."),Se("ghi","Global Horizontal Irradiance — total sunlight energy on a flat surface (W/m²); the raw “how sunny” number the forecast is built from."),Se("producing now","Solar power being generated right now."),Se("peak today","The highest solar power reached so far today."),Se("coefficient|peak response|response coefficient","Learned response coefficient — watts of PV produced per W/m² of sunlight. Captures panel size, orientation, shading and inverter clipping."),Se("strongest hour","The hour of day your arrays convert sunlight to power most efficiently — reveals their orientation."),Se("observed peak pv","The highest PV output actually recorded at this hour-of-day."),Se("soiling","Dust/pollen on the panels cutting output. Detected by comparing clear-sky production to the cleanest day on record."),Se("output drop","How far clear-sky solar output has fallen below the clean-panel baseline — the soiling indicator."),Se("backup|backup pool","SHP2 backup pool — the combined battery the Smart Home Panel draws on."),Se("backup %","Backup-pool state of charge, trended over the last hour."),Se("reserve floor|backup reserve|reserve","Reserve floor — the state of charge held back for backup. Loads begin shedding below it."),Se("solar reserve","Target state of charge to keep in reserve specifically when running on solar."),Se("mid-priority floor","The SoC at which mid-priority circuits are cut to protect the battery."),Se("charge power","Power currently flowing into the battery."),Se("charge time","Estimated time to fully charge the battery."),Se("rated power","The device’s rated maximum power output."),Se("ems bat temp","Battery temperature as reported by the SHP2’s energy-management system."),Se("hw link","Hardware (wired) link status between the SHP2 and this DPU."),Se("load-shed strategy","The SHP2’s automatic plan for dropping circuits as the battery depletes."),Se("smart backup mode","The SHP2’s backup-behaviour mode setting."),Se("charge schedule","The SHP2’s time-of-use scheduled charging windows."),Se("error code|direct errors|shp2 errors","Device-reported error code — 0 means no fault."),Se("charging power","Power the EV charger is drawing, over the last 24 hours."),Se("sessions today","Charging sessions detected today — a sustained draw above 1 kW."),Se("host dpu|dpu battery","The Delta Pro Ultra the EV charger is wired to — that DPU’s AC output equals the charging draw."),Se("direct telemetry|direct evse telemetry","Raw data straight from the device over MQTT, rather than inferred."),Se("solar next 24 h|solar next 24h","Projected solar production, from the cloud forecast run through your learned array model."),Se("forecast load|forecast load 24 h|typical solar / day","Projected household load from the typical-day consumption curve."),Se("forecast pv","Projected PV output for this hour."),Se("projected low soc","The lowest the battery is forecast to reach over the next 24 hours."),Se("cloud cover","Forecast cloud cover — what derates the solar prediction each hour."),Se("outlook","At-a-glance battery comfort vs the reserve floor: Comfortable, Watch or Tight."),Se("history depth","Days of recorded data behind the forecast and learned models — they sharpen as it grows."),Se("confidence","How trustworthy the learned model is, based on how many samples it has."),Se("z-score|peer z-score","Modified z-score — how many robust deviations a reading sits from normal. Higher = more anomalous; ≥ 3.5 flags, ≥ 5 warns."),Se("fit quality|fit r²","R-squared — how well the trend line fits the data, 0–1. Higher means a more trustworthy projection."),Se("samples|regression samples","How many data points the estimate is built from — more points, more reliable."),Se("sibling median","The median reading across the pack’s four siblings — the “normal” this pack is compared against."),Se("this pack","This pack’s current reading."),Se("deviation","How far this reading sits from the expected/normal value."),Se("baseline window","The span of history and number of samples behind the self-baseline."),Se("decline rate|rise rate","How fast the value is changing, per unit time."),Se("end-of-life|eol|projected eol|reaches 80%","End of life — the 80%-SoH point where a pack has lost a fifth of its original capacity; the conventional LFP replacement mark."),Se("fade rate|fade / yr|avg fade rate","How fast measured capacity (State of Health) is falling — SoH percentage points lost per year."),Se("service left|years left|years to eol","Projected years of service remaining before the pack reaches the 80% end-of-life threshold."),Se("eol threshold","The State of Health at which a pack counts as end-of-life — conventionally 80% for LFP cells."),Se("packs projecting","How many packs have a firm enough SoH trend to project an end-of-life date."),Se("soonest eol","The pack across the fleet projected to reach end-of-life first."),Se("cycles at eol","Projected equivalent full-cycle count by the time the pack reaches end-of-life."),Se("data span","Days of recorded history the projection is regressed over."),Se("projection notes","Plain-language end-of-life verdict for each pack with a firm fade trend."),Se("trend","Whether a pack has a projected fade trend, is stable, is still learning, or has no data yet."),Se("critical","Critical — an immediate problem that needs attention now."),Se("warnings|warning","Warning — something to investigate soon."),Se("informational|info","Informational — noted for awareness, not urgent."),Se("anomalies","Things unusual right now — flagged by peer comparison and self-baseline."),Se("forecasts","Where things are heading — runtime, degradation and day-ahead projections."),Se("actionable","Critical + warning items that may need attention."),Se("recently cleared","Alerts that were raised and have since resolved, with how long each lasted."),Se("today","Energy totals since local midnight."),Se("solar produced","Total solar energy harvested today."),Se("batteries","Net battery energy today — negative means net charged, positive means net discharged.");let He=class extends de{constructor(){super(...arguments),this.tone="neutral"}render(){return B`<slot></slot>`}};He.styles=[we,n`
      :host {
        display: inline-flex;
        align-items: center;
        font-size: 0.75rem;
        font-weight: 600;
        padding: 2px 8px;
        border-radius: 999px;
        line-height: 1.5;
        background: var(--ef-line);
        color: var(--ef-ink);
        white-space: nowrap;
      }
      :host([tone='ok']) {
        background: color-mix(in srgb, var(--ef-ok) 20%, transparent);
        color: var(--ef-ok);
      }
      :host([tone='warn']) {
        background: color-mix(in srgb, var(--ef-warn) 22%, transparent);
        color: var(--ef-warn);
      }
      :host([tone='bad']) {
        background: color-mix(in srgb, var(--ef-bad) 22%, transparent);
        color: var(--ef-bad);
      }
      :host([tone='info']) {
        background: color-mix(in srgb, var(--ef-info) 22%, transparent);
        color: var(--ef-info);
      }
    `],t([ge({reflect:!0})],He.prototype,"tone",void 0),He=t([pe("ef-badge")],He);let Me=class extends de{constructor(){super(...arguments),this.label="",this.value="",this.unit=""}render(){return B`
      <div class="label"><slot name="label">${this.label}</slot></div>
      <div class="value-line">
        <span class="value"><slot name="value">${this.value}</slot></span>
        ${this.unit?B`<span class="unit">${this.unit}</span>`:null}
      </div>
      <slot></slot>
    `}};Me.styles=[we,n`
      :host {
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding: 10px 12px;
        border: 1px solid var(--ef-line);
        border-radius: 8px;
        background: var(--ef-panel);
        min-width: 88px;
      }
      .label {
        font-size: 0.75rem;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--ef-muted);
        line-height: 1.2;
      }
      .value-line {
        display: flex;
        align-items: baseline;
        gap: 4px;
        color: var(--ef-ink);
      }
      .value {
        font-size: 1.4rem;
        font-weight: 600;
        line-height: 1.1;
      }
      .unit {
        font-size: 0.8rem;
        color: var(--ef-muted);
      }
      ::slotted(*) {
        font-size: 0.75rem;
        color: var(--ef-muted);
      }
    `],t([ge()],Me.prototype,"label",void 0),t([ge()],Me.prototype,"value",void 0),t([ge()],Me.prototype,"unit",void 0),Me=t([pe("ef-tile")],Me);let je=class extends de{constructor(){super(...arguments),this.title=""}render(){return B`
      <header>
        <div class="title"><slot name="title">${this.title}</slot></div>
        <div class="header-extra"><slot name="header"></slot></div>
      </header>
      <div class="body"><slot></slot></div>
    `}};je.styles=[we,n`
      :host {
        display: block;
        border: 1px solid var(--ef-line);
        border-radius: 10px;
        background: var(--ef-panel);
        padding: 12px 14px;
        color: var(--ef-ink);
      }
      header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 10px;
      }
      .title {
        font-weight: 600;
        font-size: 0.95rem;
      }
      .header-extra {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 0.8rem;
        color: var(--ef-muted);
      }
      .body {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
    `],t([ge()],je.prototype,"title",void 0),je=t([pe("ef-section")],je);e.EcoflowSolarCard=class extends be{constructor(){super(...arguments),this.today={data:null,stale:!1},this.forecast={data:null,stale:!1},this.prob={data:null,stale:!1},this.clipping={data:null,stale:!1},this.soiling={data:null,stale:!1},this.shade={data:null,stale:!1},this._fastTimer=null,this._slowTimer=null}connectedCallback(){super.connectedCallback(),this._kickFast(),this._kickSlow();const e=Math.max(10,this.config?.refresh_seconds??30),t=Math.max(e,60);this._fastTimer=setInterval(()=>this._kickFast(),1e3*e),this._slowTimer=setInterval(()=>this._kickSlow(),1e3*t)}disconnectedCallback(){super.disconnectedCallback(),this._fastTimer&&(clearInterval(this._fastTimer),this._fastTimer=null),this._slowTimer&&(clearInterval(this._slowTimer),this._slowTimer=null)}_kickFast(){this._fetchOne("/api/summary/today",()=>this.today,e=>this.today=e),this._fetchOne("/api/forecast",()=>this.forecast,e=>this.forecast=e),this._fetchOne("/api/forecast/probabilistic",()=>this.prob,e=>this.prob=e)}_kickSlow(){this._fetchOne("/api/clipping",()=>this.clipping,e=>this.clipping=e),this._fetchOne("/api/soiling-decomposition",()=>this.soiling,e=>this.soiling=e),this._fetchOne("/api/shade-report",()=>this.shade,e=>this.shade=e)}async _fetchOne(e,t,s){try{const t=this.effectiveHost().replace(/\/$/,"")+e,o=await fetch(t);if(!o.ok)throw new Error(`HTTP ${o.status}`);s({data:await o.json(),stale:!1})}catch{s({...t(),stale:!0})}}connTone(e){return"open"===e?"ok":"connecting"===e||"reconnecting"===e?"warn":"closed"===e?"bad":"neutral"}connLabel(e){return"open"===e?"live":"connecting"===e?"linking":"reconnecting"===e?"reconnecting":"closed"===e?"offline":"idle"}dpuList(){const e=this.snapshot;if(!e)return[];var t;return(t=Object.values(e.devices),[...t].sort(ke)).filter(e=>"dpu"===e.projection?.kind&&e.online)}wiredArraySns(){const e=this.snapshot;if(!e)return new Set;const t=Object.values(e.devices).find(e=>"shp2"===e.projection?.kind);return t?new Set(t.projection.sources.map(e=>e.sn).filter(e=>!!e)):new Set}render(){const e=this.snapshot,t=this.config?.title??"Solar";if(!e)return B`<ha-card>
        <div class="header">
          <div>
            <div class="title">${t}</div>
            <div class="subtitle">${this.effectiveHost()}</div>
          </div>
          <div class="badges">
            <ef-badge tone=${this.connTone(this.connState)}>${this.connLabel(this.connState)}</ef-badge>
          </div>
        </div>
        <div class="skeleton"><span class="dot"></span>Connecting to add-on…</div>
      </ha-card>`;const s=this.dpuList(),o=this.wiredArraySns(),i=o.size>0?s.filter(e=>o.has(e.sn)):s,r=14*i.length;return B`<ha-card>
      <div class="header">
        <div>
          <div class="title">${t}</div>
          <div class="subtitle">
            ${s.length} DPU${1===s.length?"":"s"} online · ${r} panels ·
            ${10} HV + ${4} LV per array
          </div>
        </div>
        <div class="badges">
          <ef-badge tone=${this.connTone(this.connState)}>${this.connLabel(this.connState)}</ef-badge>
        </div>
      </div>
      ${this.renderHeadline(s)}
      ${this.renderMpptTable(s,o)}
      ${this.renderForecast()}
      ${this.renderResponseSection()}
    </ha-card>`}renderHeadline(e){const t=e.reduce((e,t)=>e+(t.projection.pvTotalWatts??0),0),s=e.reduce((e,t)=>e+(t.projection.pvHighWatts??0),0),o=e.reduce((e,t)=>e+(t.projection.pvLowWatts??0),0),i=this.today.data,r=this.forecast.data,a=e=>null==e?"—":(e/1e3).toFixed(1),n=i?a(i.fleet.pvWh):"—",l=r?a(r.forecastPvWhNext24):"—";return B`<ef-section .title=${"Solar"}>
      ${this.today.stale||this.forecast.stale?B`<ef-badge slot="header" tone="warn">stale data</ef-badge>`:Z}
      <div class="full">
        <div class="top-row">
          <ef-tile label="Now" value=${_e(t)} unit="">
            <span>HV ${_e(s)} · LV ${_e(o)}</span>
          </ef-tile>
          <ef-tile label="Today" value=${n} unit=${i?"kWh":""}>
            <span>${i?`${Math.round(100*i.fleet.coverage)}% measured`:""}</span>
          </ef-tile>
          <ef-tile label="Forecast 24h" value=${l} unit=${r?"kWh":""}>
            <span>${r?r.hasWeather?"cloud-aware":"typical-day":""}</span>
          </ef-tile>
        </div>
      </div>
    </ef-section>`}renderMpptTable(e,t){if(0===e.length)return B`<ef-section .title=${"Per-MPPT strings (HV + LV)"}>
        <div class="mppt-empty">No online DPUs reporting MPPT data.</div>
      </ef-section>`;const s=[];let o=0,i=0;for(const r of e){const e=0===t.size||t.has(r.sn);o+=1,s.push({key:`${r.sn}-hv`,device:r.deviceName,stringLabel:`HV-${o}`,kind:"HV",watts:r.projection.pvHighWatts,volts:r.projection.pvHighVolts,amps:r.projection.pvHighAmps,errCode:r.projection.pvHighErrCode,arrayed:e}),i+=1,s.push({key:`${r.sn}-lv`,device:r.deviceName,stringLabel:`LV-${i}`,kind:"LV",watts:r.projection.pvLowWatts,volts:r.projection.pvLowVolts,amps:r.projection.pvLowAmps,errCode:r.projection.pvLowErrCode,arrayed:e})}s.sort((e,t)=>e.kind===t.kind?0:"HV"===e.kind?-1:1);return B`<ef-section .title=${"Per-MPPT strings (HV + LV)"}>
      <div class="full">
        <div class="mppt-table">
          <div class="mppt-head">${Pe("mppt")} string</div>
          <div class="mppt-head mppt-num">W</div>
          <div class="mppt-head mppt-num">V</div>
          <div class="mppt-head mppt-num">A</div>
          <div class="mppt-head mppt-status">·</div>
          ${s.map(e=>{const t=(e=>0!==(e.errCode??0)?{klass:"bad",sym:"!",title:`error code ${e.errCode}`}:e.arrayed?(e.watts??0)>5?{klass:"ok",sym:"✓",title:"producing"}:{klass:"idle",sym:"·",title:"idle (no sun / no array)"}:{klass:"idle",sym:"—",title:"no array wired"})(e);return B`
              <div class="mppt-cell mppt-name">
                ${s=e.kind,B`<span class="swatch" style="background:${"HV"===s?"#d97706":"#c2410c"};" aria-hidden="true"></span>`}
                <span>
                  <span style="color:var(--ef-ink);">${e.stringLabel}</span>
                  <span style="color:var(--ef-muted);font-size:.7rem;"> · ${e.device}</span>
                </span>
              </div>
              <div class="mppt-cell mppt-num">${_e(e.watts)}</div>
              <div class="mppt-cell mppt-num">${null!=e.volts?`${e.volts.toFixed(0)} V`:"—"}</div>
              <div class="mppt-cell mppt-num">${null!=e.amps?`${e.amps.toFixed(1)} A`:"—"}</div>
              <div class="mppt-cell mppt-status ${t.klass}" title=${t.title}>${t.sym}</div>
            `;var s})}
        </div>
      </div>
    </ef-section>`}renderForecast(){const e=this.forecast.data,t=this.prob.data,s=this.forecast.stale;if(!e)return B`<ef-section .title=${"24-hour forecast"}>
        ${s?B`<ef-badge slot="header" tone="warn">stale</ef-badge>`:Z}
        <div class="subtitle">${s?"Forecast unavailable.":"Loading forecast…"}</div>
      </ef-section>`;if(!(e.hours.length>0&&e.historyDays>0))return B`<ef-section .title=${"24-hour forecast"}>
        <ef-badge slot="header" tone=${e.hasWeather?"ok":"neutral"}
          >${e.hasWeather?"cloud-aware":"history only"}</ef-badge
        >
        <div class="subtitle">Building forecast — needs a little recorded history first.</div>
      </ef-section>`;let o,i=Z;if(t&&t.hours.length>0){t.hours.map(e=>({ts:e.ts,value:e.p90W})),t.hours.map(e=>({ts:e.ts,value:e.p50W})),o=this.renderProbForecastChart(t);const e=t.uncertaintyKwhStdev,s=t.pAboveReservePct;i=B`<ef-badge slot="header" tone=${null!=s&&s<70?"warn":"ok"}
        >±${e.toFixed(1)} kWh · ${null!=s?`${s}% above reserve`:"no SoC ref"}</ef-badge
      >`}else{const t=e.hours.map(e=>({ts:e.ts,value:e.forecastPvW}));o=Te({area:{points:t,color:"#d97706",label:"Forecast PV (P50)"}},{height:200})}return B`<ef-section .title=${"24-hour forecast"}>
      <ef-badge slot="header" tone=${e.hasWeather?"ok":"neutral"}
        >${e.hasWeather?"cloud-aware":"history only"}</ef-badge
      >
      ${i}
      ${s?B`<ef-badge slot="header" tone="warn">stale</ef-badge>`:Z}
      <div class="full">${o}</div>
    </ef-section>`}renderProbForecastChart(e){const t=36,s=e.hours.map(e=>e.ts),o=Math.min(...s),i=Math.max(...s),r=1.05*Math.max(100,...e.hours.map(e=>e.p90W)),a=e=>t+(e-o)/(i-o||1)*648,n=e=>10+168*(1-e/r),l=n(0),c=[],d=[];let h=!1;for(let t=0;t<e.hours.length;t++){const s=e.hours[t],o=a(s.ts),i=n(s.p90W);c.push(`${h?"L":"M"} ${o.toFixed(1)} ${i.toFixed(1)}`),h=!0}for(let t=e.hours.length-1;t>=0;t--){const s=e.hours[t],o=a(s.ts),i=n(s.p10W);d.push(`L ${o.toFixed(1)} ${i.toFixed(1)}`)}const p=c.length?`${c.join(" ")} ${d.join(" ")} Z`:"",u=[];let f=!1;for(const t of e.hours){const e=a(t.ts),s=n(t.p50W);u.push(`${f?"L":"M"} ${e.toFixed(1)} ${s.toFixed(1)}`),f=!0}const g=u.join(" "),v=216e5,m=[];for(let e=Math.ceil(o/v)*v;e<=i;e+=v){const t=a(e);m.push(q`<line x1=${t} x2=${t} y1=${10} y2=${178} stroke="var(--ef-line)" stroke-dasharray="2 3" stroke-opacity=".6" />`)}const y=[0,r/2,r].map(e=>({v:e,y:n(e)}));return B`<svg
        viewBox="0 0 ${720} ${200}"
        width="100%"
        height=${200}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        ${m}
        ${y.map(e=>q`<line x1=${t} x2=${684} y1=${e.y} y2=${e.y} stroke="var(--ef-line)" stroke-opacity=".4" />
            <text x=${32} y=${e.y+3} text-anchor="end" font-size="9" fill="var(--ef-muted)">${(e.v/1e3).toFixed(1)}k</text>`)}
        ${p?q`<path d=${p} fill="#d97706" fill-opacity=".18" stroke="none" />`:null}
        ${g?q`<path d=${g} fill="none" stroke="#d97706" stroke-width="1.8" />`:null}
        <line
          x1=${t}
          x2=${684}
          y1=${l}
          y2=${l}
          stroke="var(--ef-line)"
          stroke-opacity=".6"
        />
      </svg>
      <div
        style="display:flex;flex-wrap:wrap;gap:10px;font-size:11px;color:var(--ef-muted);margin-top:4px;"
      >
        <span
          ><span
            style="display:inline-block;width:10px;height:10px;opacity:.6;border-radius:2px;margin-right:4px;background:#d97706;"
          ></span
          >P10–P90 band</span
        >
        <span
          ><span
            style="display:inline-block;width:14px;height:2px;margin-right:4px;vertical-align:middle;background:#d97706;"
          ></span
          >P50 median</span
        >
      </div>`}renderResponseSection(){const e=this.clipping.stale||this.soiling.stale||this.shade.stale;return B`<ef-section .title=${"Solar response · what's holding output back"}>
      ${e?B`<ef-badge slot="header" tone="warn">stale</ef-badge>`:Z}
      <div class="diag-list">
        ${this.renderClippingRow()} ${this.renderSoilingRow()} ${this.renderShadeRow()}
      </div>
    </ef-section>`}renderClippingRow(){const e=this.clipping.data;if(!e)return B`<div class="diag-row">
        <span class="diag-icon">·</span>
        <div class="diag-text">
          <strong>Clipping</strong> ·
          <span class="muted">${this.clipping.stale?"unavailable":"computing…"}</span>
        </div>
      </div>`;const t=e.perHour.filter(e=>e.clippedW>5).length,s=e.todayKwh,o=s>.2?B`<strong>${s.toFixed(1)} kWh</strong> clipped today over ${t} hour${1===t?"":"s"}`:B`<strong>0 kWh</strong> clipped today — array peak ${_e(e.arrayPeakW)}`,i=s>.2?`Inverter capped output at peak (~${_e(e.arrayPeakW)}); more arrays or batteries could absorb the surplus.`:"Inverter is keeping up with peak production — no power lost to clipping.";return B`<div class="diag-row">
      <span class="diag-icon" style="color:${s>.2?"var(--ef-warn)":"var(--ef-ok)"};"
        >${s>.2?"!":"✓"}</span
      >
      <div class="diag-text">
        ${Pe("clipping")}: ${o}<br />
        <span class="muted">${i}</span>
      </div>
    </div>`}renderSoilingRow(){const e=this.soiling.data;if(!e)return B`<div class="diag-row">
        <span class="diag-icon">·</span>
        <div class="diag-text">
          <strong>${Pe("soiling")}</strong> ·
          <span class="muted">${this.soiling.stale?"unavailable":"computing…"}</span>
        </div>
      </div>`;const t=[...e.perDevice].filter(e=>null!=e.dropPct).sort((e,t)=>(t.dropPct??0)-(e.dropPct??0))[0];if(!t||null==t.dropPct)return B`<div class="diag-row">
        <span class="diag-icon" style="color:var(--ef-muted);">·</span>
        <div class="diag-text">
          ${Pe("soiling")}:
          <strong>insufficient clear-sky history</strong>
          <br /><span class="muted">Needs ~6 clear days to flag a soiling trend.</span>
        </div>
      </div>`;const s=t.dropPct>=12,o=!s&&t.dropPct>=6,i=s||o?"var(--ef-warn)":"var(--ef-ok)",r=s?"!":o?"·":"✓",a=s?`Worst-affected: ${t.device} (${t.dropPct.toFixed(0)}% below clean-day baseline) — a wash should recover most.`:o?`Worst-affected: ${t.device} (${t.dropPct.toFixed(0)}% below clean-day) — minor, worth a rinse soon.`:"Panels are tracking the clean-day baseline — no soiling detected.";return B`<div class="diag-row">
      <span class="diag-icon" style="color:${i};">${r}</span>
      <div class="diag-text">
        ${Pe("soiling")}: <strong>${t.dropPct.toFixed(0)}% ${Pe("output drop")}</strong>
        <br /><span class="muted">${a}</span>
      </div>
    </div>`}renderShadeRow(){const e=this.shade.data;if(!e)return B`<div class="diag-row">
        <span class="diag-icon">·</span>
        <div class="diag-text">
          <strong>Shade</strong> ·
          <span class="muted">${this.shade.stale?"unavailable":"computing…"}</span>
        </div>
      </div>`;const t=[...e.hours].sort((e,t)=>t.shortfallPct-e.shortfallPct)[0];if(!t||t.shortfallPct<8)return B`<div class="diag-row">
        <span class="diag-icon" style="color:var(--ef-ok);">✓</span>
        <div class="diag-text">
          Shade: <strong>none detected</strong><br /><span class="muted"
            >No hours showing a meaningful shortfall vs clear-sky expected output.</span
          >
        </div>
      </div>`;const s=e=>0===e?"12 AM":e<12?`${e} AM`:12===e?"12 PM":e-12+" PM",o=e.estTotalKwhPerYear;return B`<div class="diag-row">
      <span class="diag-icon" style="color:var(--ef-warn);">!</span>
      <div class="diag-text">
        Shade: <strong>${t.shortfallPct.toFixed(0)}% shortfall</strong> at ${s(t.hour)}<br /><span
          class="muted"
          >Around ${s(t.hour)} the array produces ${_e(t.observedW)} vs ${_e(t.expectedW)} clear-sky.${o>0?` Est. ~${o.toFixed(0)} kWh/year lost.`:""}</span
        >
      </div>
    </div>`}},e.EcoflowSolarCard.styles=[we,n`
      :host {
        display: block;
      }
      ha-card {
        padding: 12px;
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }
      .title {
        font-size: 1.1rem;
        font-weight: 600;
        color: var(--ef-ink);
      }
      .subtitle {
        font-size: 0.75rem;
        color: var(--ef-muted);
        margin-top: 2px;
      }
      .badges {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .skeleton {
        padding: 20px;
        text-align: center;
        color: var(--ef-muted);
        font-size: 0.85rem;
      }
      .skeleton .dot {
        display: inline-block;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--ef-accent);
        margin-right: 6px;
        animation: ef-pulse 1.2s ease-in-out infinite;
      }
      @keyframes ef-pulse {
        0%, 100% { opacity: .3; }
        50% { opacity: 1; }
      }
      .top-row {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
        gap: 8px;
        width: 100%;
      }
      .full {
        width: 100%;
      }
      /* Per-MPPT grid — 5 columns: name | W | V | A | status */
      .mppt-table {
        display: grid;
        grid-template-columns: 1fr 70px 60px 60px 24px;
        column-gap: 8px;
        row-gap: 2px;
        width: 100%;
        font-size: 0.82rem;
        color: var(--ef-ink);
        font-variant-numeric: tabular-nums;
      }
      .mppt-head {
        font-size: 0.65rem;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--ef-muted);
        padding-bottom: 2px;
        border-bottom: 1px solid var(--ef-line);
      }
      .mppt-cell {
        padding: 3px 0;
        border-bottom: 1px solid color-mix(in srgb, var(--ef-line) 50%, transparent);
      }
      .mppt-name {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .swatch {
        display: inline-block;
        width: 6px;
        height: 14px;
        border-radius: 1px;
      }
      .mppt-num {
        text-align: right;
      }
      .mppt-status {
        text-align: center;
      }
      .mppt-status.ok {
        color: var(--ef-ok);
      }
      .mppt-status.bad {
        color: var(--ef-bad);
      }
      .mppt-status.idle {
        color: var(--ef-muted);
      }
      .mppt-empty {
        grid-column: 1 / -1;
        padding: 6px 0;
        color: var(--ef-muted);
        font-size: 0.78rem;
      }
      .diag-list {
        display: flex;
        flex-direction: column;
        gap: 6px;
        width: 100%;
      }
      .diag-row {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        font-size: 0.85rem;
        line-height: 1.4;
        color: var(--ef-ink);
      }
      .diag-icon {
        flex: 0 0 auto;
        font-size: 1rem;
        margin-top: 1px;
      }
      .diag-text {
        flex: 1 1 auto;
      }
      .diag-text .muted {
        color: var(--ef-muted);
        font-size: 0.78rem;
      }
      .ratio-bar {
        position: relative;
        width: 56px;
        height: 4px;
        background: var(--ef-line);
        border-radius: 2px;
        margin-left: 4px;
        vertical-align: middle;
        display: inline-block;
      }
      .ratio-bar > span {
        position: absolute;
        top: 0;
        left: 0;
        bottom: 0;
        background: var(--ef-accent);
        border-radius: 2px;
      }
    `],t([ve()],e.EcoflowSolarCard.prototype,"today",void 0),t([ve()],e.EcoflowSolarCard.prototype,"forecast",void 0),t([ve()],e.EcoflowSolarCard.prototype,"prob",void 0),t([ve()],e.EcoflowSolarCard.prototype,"clipping",void 0),t([ve()],e.EcoflowSolarCard.prototype,"soiling",void 0),t([ve()],e.EcoflowSolarCard.prototype,"shade",void 0),e.EcoflowSolarCard=t([pe("ecoflow-solar-card")],e.EcoflowSolarCard);const Le=window;return Le.customCards=Le.customCards||[],Le.customCards.some(e=>"ecoflow-solar-card"===e.type)||Le.customCards.push({type:"ecoflow-solar-card",name:"EcoFlow Solar Card",description:"Live PV + per-MPPT detail + day-ahead forecast + diagnostics"}),e}({});
//# sourceMappingURL=ecoflow-solar-card.js.map
