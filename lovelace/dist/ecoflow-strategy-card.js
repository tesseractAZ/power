var EcoflowStrategyCard=function(e){"use strict";function t(e,t,r,s){var o,i=arguments.length,a=i<3?t:null===s?s=Object.getOwnPropertyDescriptor(t,r):s;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)a=Reflect.decorate(e,t,r,s);else for(var n=e.length-1;n>=0;n--)(o=e[n])&&(a=(i<3?o(a):i>3?o(t,r,a):o(t,r))||a);return i>3&&a&&Object.defineProperty(t,r,a),a}"function"==typeof SuppressedError&&SuppressedError;
/**
     * @license
     * Copyright 2019 Google LLC
     * SPDX-License-Identifier: BSD-3-Clause
     */
const r=globalThis,s=r.ShadowRoot&&(void 0===r.ShadyCSS||r.ShadyCSS.nativeShadow)&&"adoptedStyleSheets"in Document.prototype&&"replace"in CSSStyleSheet.prototype,o=Symbol(),i=new WeakMap;let a=class{constructor(e,t,r){if(this._$cssResult$=!0,r!==o)throw Error("CSSResult is not constructable. Use `unsafeCSS` or `css` instead.");this.cssText=e,this.t=t}get styleSheet(){let e=this.o;const t=this.t;if(s&&void 0===e){const r=void 0!==t&&1===t.length;r&&(e=i.get(t)),void 0===e&&((this.o=e=new CSSStyleSheet).replaceSync(this.cssText),r&&i.set(t,e))}return e}toString(){return this.cssText}};const n=(e,...t)=>{const r=1===e.length?e[0]:t.reduce((t,r,s)=>t+(e=>{if(!0===e._$cssResult$)return e.cssText;if("number"==typeof e)return e;throw Error("Value passed to 'css' function must be a 'css' function result: "+e+". Use 'unsafeCSS' to pass non-literal values, but take care to ensure page security.")})(r)+e[s+1],e[0]);return new a(r,e,o)},l=s?e=>e:e=>e instanceof CSSStyleSheet?(e=>{let t="";for(const r of e.cssRules)t+=r.cssText;return(e=>new a("string"==typeof e?e:e+"",void 0,o))(t)})(e):e,{is:c,defineProperty:d,getOwnPropertyDescriptor:h,getOwnPropertyNames:p,getOwnPropertySymbols:u,getPrototypeOf:f}=Object,g=globalThis,m=g.trustedTypes,v=m?m.emptyScript:"",b=g.reactiveElementPolyfillSupport,y=(e,t)=>e,w={toAttribute(e,t){switch(t){case Boolean:e=e?v:null;break;case Object:case Array:e=null==e?e:JSON.stringify(e)}return e},fromAttribute(e,t){let r=e;switch(t){case Boolean:r=null!==e;break;case Number:r=null===e?null:Number(e);break;case Object:case Array:try{r=JSON.parse(e)}catch(e){r=null}}return r}},$=(e,t)=>!c(e,t),_={attribute:!0,type:String,converter:w,reflect:!1,useDefault:!1,hasChanged:$};
/**
     * @license
     * Copyright 2017 Google LLC
     * SPDX-License-Identifier: BSD-3-Clause
     */Symbol.metadata??=Symbol("metadata"),g.litPropertyMetadata??=new WeakMap;let k=class extends HTMLElement{static addInitializer(e){this._$Ei(),(this.l??=[]).push(e)}static get observedAttributes(){return this.finalize(),this._$Eh&&[...this._$Eh.keys()]}static createProperty(e,t=_){if(t.state&&(t.attribute=!1),this._$Ei(),this.prototype.hasOwnProperty(e)&&((t=Object.create(t)).wrapped=!0),this.elementProperties.set(e,t),!t.noAccessor){const r=Symbol(),s=this.getPropertyDescriptor(e,r,t);void 0!==s&&d(this.prototype,e,s)}}static getPropertyDescriptor(e,t,r){const{get:s,set:o}=h(this.prototype,e)??{get(){return this[t]},set(e){this[t]=e}};return{get:s,set(t){const i=s?.call(this);o?.call(this,t),this.requestUpdate(e,i,r)},configurable:!0,enumerable:!0}}static getPropertyOptions(e){return this.elementProperties.get(e)??_}static _$Ei(){if(this.hasOwnProperty(y("elementProperties")))return;const e=f(this);e.finalize(),void 0!==e.l&&(this.l=[...e.l]),this.elementProperties=new Map(e.elementProperties)}static finalize(){if(this.hasOwnProperty(y("finalized")))return;if(this.finalized=!0,this._$Ei(),this.hasOwnProperty(y("properties"))){const e=this.properties,t=[...p(e),...u(e)];for(const r of t)this.createProperty(r,e[r])}const e=this[Symbol.metadata];if(null!==e){const t=litPropertyMetadata.get(e);if(void 0!==t)for(const[e,r]of t)this.elementProperties.set(e,r)}this._$Eh=new Map;for(const[e,t]of this.elementProperties){const r=this._$Eu(e,t);void 0!==r&&this._$Eh.set(r,e)}this.elementStyles=this.finalizeStyles(this.styles)}static finalizeStyles(e){const t=[];if(Array.isArray(e)){const r=new Set(e.flat(1/0).reverse());for(const e of r)t.unshift(l(e))}else void 0!==e&&t.push(l(e));return t}static _$Eu(e,t){const r=t.attribute;return!1===r?void 0:"string"==typeof r?r:"string"==typeof e?e.toLowerCase():void 0}constructor(){super(),this._$Ep=void 0,this.isUpdatePending=!1,this.hasUpdated=!1,this._$Em=null,this._$Ev()}_$Ev(){this._$ES=new Promise(e=>this.enableUpdating=e),this._$AL=new Map,this._$E_(),this.requestUpdate(),this.constructor.l?.forEach(e=>e(this))}addController(e){(this._$EO??=new Set).add(e),void 0!==this.renderRoot&&this.isConnected&&e.hostConnected?.()}removeController(e){this._$EO?.delete(e)}_$E_(){const e=new Map,t=this.constructor.elementProperties;for(const r of t.keys())this.hasOwnProperty(r)&&(e.set(r,this[r]),delete this[r]);e.size>0&&(this._$Ep=e)}createRenderRoot(){const e=this.shadowRoot??this.attachShadow(this.constructor.shadowRootOptions);return((e,t)=>{if(s)e.adoptedStyleSheets=t.map(e=>e instanceof CSSStyleSheet?e:e.styleSheet);else for(const s of t){const t=document.createElement("style"),o=r.litNonce;void 0!==o&&t.setAttribute("nonce",o),t.textContent=s.cssText,e.appendChild(t)}})(e,this.constructor.elementStyles),e}connectedCallback(){this.renderRoot??=this.createRenderRoot(),this.enableUpdating(!0),this._$EO?.forEach(e=>e.hostConnected?.())}enableUpdating(e){}disconnectedCallback(){this._$EO?.forEach(e=>e.hostDisconnected?.())}attributeChangedCallback(e,t,r){this._$AK(e,r)}_$ET(e,t){const r=this.constructor.elementProperties.get(e),s=this.constructor._$Eu(e,r);if(void 0!==s&&!0===r.reflect){const o=(void 0!==r.converter?.toAttribute?r.converter:w).toAttribute(t,r.type);this._$Em=e,null==o?this.removeAttribute(s):this.setAttribute(s,o),this._$Em=null}}_$AK(e,t){const r=this.constructor,s=r._$Eh.get(e);if(void 0!==s&&this._$Em!==s){const e=r.getPropertyOptions(s),o="function"==typeof e.converter?{fromAttribute:e.converter}:void 0!==e.converter?.fromAttribute?e.converter:w;this._$Em=s;const i=o.fromAttribute(t,e.type);this[s]=i??this._$Ej?.get(s)??i,this._$Em=null}}requestUpdate(e,t,r,s=!1,o){if(void 0!==e){const i=this.constructor;if(!1===s&&(o=this[e]),r??=i.getPropertyOptions(e),!((r.hasChanged??$)(o,t)||r.useDefault&&r.reflect&&o===this._$Ej?.get(e)&&!this.hasAttribute(i._$Eu(e,r))))return;this.C(e,t,r)}!1===this.isUpdatePending&&(this._$ES=this._$EP())}C(e,t,{useDefault:r,reflect:s,wrapped:o},i){r&&!(this._$Ej??=new Map).has(e)&&(this._$Ej.set(e,i??t??this[e]),!0!==o||void 0!==i)||(this._$AL.has(e)||(this.hasUpdated||r||(t=void 0),this._$AL.set(e,t)),!0===s&&this._$Em!==e&&(this._$Eq??=new Set).add(e))}async _$EP(){this.isUpdatePending=!0;try{await this._$ES}catch(e){Promise.reject(e)}const e=this.scheduleUpdate();return null!=e&&await e,!this.isUpdatePending}scheduleUpdate(){return this.performUpdate()}performUpdate(){if(!this.isUpdatePending)return;if(!this.hasUpdated){if(this.renderRoot??=this.createRenderRoot(),this._$Ep){for(const[e,t]of this._$Ep)this[e]=t;this._$Ep=void 0}const e=this.constructor.elementProperties;if(e.size>0)for(const[t,r]of e){const{wrapped:e}=r,s=this[t];!0!==e||this._$AL.has(t)||void 0===s||this.C(t,void 0,r,s)}}let e=!1;const t=this._$AL;try{e=this.shouldUpdate(t),e?(this.willUpdate(t),this._$EO?.forEach(e=>e.hostUpdate?.()),this.update(t)):this._$EM()}catch(t){throw e=!1,this._$EM(),t}e&&this._$AE(t)}willUpdate(e){}_$AE(e){this._$EO?.forEach(e=>e.hostUpdated?.()),this.hasUpdated||(this.hasUpdated=!0,this.firstUpdated(e)),this.updated(e)}_$EM(){this._$AL=new Map,this.isUpdatePending=!1}get updateComplete(){return this.getUpdateComplete()}getUpdateComplete(){return this._$ES}shouldUpdate(e){return!0}update(e){this._$Eq&&=this._$Eq.forEach(e=>this._$ET(e,this[e])),this._$EM()}updated(e){}firstUpdated(e){}};k.elementStyles=[],k.shadowRootOptions={mode:"open"},k[y("elementProperties")]=new Map,k[y("finalized")]=new Map,b?.({ReactiveElement:k}),(g.reactiveElementVersions??=[]).push("2.1.2");
/**
     * @license
     * Copyright 2017 Google LLC
     * SPDX-License-Identifier: BSD-3-Clause
     */
const x=globalThis,S=e=>e,A=x.trustedTypes,P=A?A.createPolicy("lit-html",{createHTML:e=>e}):void 0,E="$lit$",C=`lit$${Math.random().toFixed(9).slice(2)}$`,T="?"+C,H=`<${T}>`,M=document,R=()=>M.createComment(""),U=e=>null===e||"object"!=typeof e&&"function"!=typeof e,O=Array.isArray,D="[ \t\n\f\r]",z=/<(?:(!--|\/[^a-zA-Z])|(\/?[a-zA-Z][^>\s]*)|(\/?$))/g,j=/-->/g,N=/>/g,L=RegExp(`>|${D}(?:([^\\s"'>=/]+)(${D}*=${D}*(?:[^ \t\n\f\r"'\`<>=]|("|')|))|$)`,"g"),W=/'/g,B=/"/g,I=/^(?:script|style|textarea|title)$/i,F=(e=>(t,...r)=>({_$litType$:e,strings:t,values:r}))(1),q=Symbol.for("lit-noChange"),V=Symbol.for("lit-nothing"),K=new WeakMap,G=M.createTreeWalker(M,129);function J(e,t){if(!O(e)||!e.hasOwnProperty("raw"))throw Error("invalid template strings array");return void 0!==P?P.createHTML(t):t}const Y=(e,t)=>{const r=e.length-1,s=[];let o,i=2===t?"<svg>":3===t?"<math>":"",a=z;for(let t=0;t<r;t++){const r=e[t];let n,l,c=-1,d=0;for(;d<r.length&&(a.lastIndex=d,l=a.exec(r),null!==l);)d=a.lastIndex,a===z?"!--"===l[1]?a=j:void 0!==l[1]?a=N:void 0!==l[2]?(I.test(l[2])&&(o=RegExp("</"+l[2],"g")),a=L):void 0!==l[3]&&(a=L):a===L?">"===l[0]?(a=o??z,c=-1):void 0===l[1]?c=-2:(c=a.lastIndex-l[2].length,n=l[1],a=void 0===l[3]?L:'"'===l[3]?B:W):a===B||a===W?a=L:a===j||a===N?a=z:(a=L,o=void 0);const h=a===L&&e[t+1].startsWith("/>")?" ":"";i+=a===z?r+H:c>=0?(s.push(n),r.slice(0,c)+E+r.slice(c)+C+h):r+C+(-2===c?t:h)}return[J(e,i+(e[r]||"<?>")+(2===t?"</svg>":3===t?"</math>":"")),s]};class Z{constructor({strings:e,_$litType$:t},r){let s;this.parts=[];let o=0,i=0;const a=e.length-1,n=this.parts,[l,c]=Y(e,t);if(this.el=Z.createElement(l,r),G.currentNode=this.el.content,2===t||3===t){const e=this.el.content.firstChild;e.replaceWith(...e.childNodes)}for(;null!==(s=G.nextNode())&&n.length<a;){if(1===s.nodeType){if(s.hasAttributes())for(const e of s.getAttributeNames())if(e.endsWith(E)){const t=c[i++],r=s.getAttribute(e).split(C),a=/([.?@])?(.*)/.exec(t);n.push({type:1,index:o,name:a[2],strings:r,ctor:"."===a[1]?re:"?"===a[1]?se:"@"===a[1]?oe:te}),s.removeAttribute(e)}else e.startsWith(C)&&(n.push({type:6,index:o}),s.removeAttribute(e));if(I.test(s.tagName)){const e=s.textContent.split(C),t=e.length-1;if(t>0){s.textContent=A?A.emptyScript:"";for(let r=0;r<t;r++)s.append(e[r],R()),G.nextNode(),n.push({type:2,index:++o});s.append(e[t],R())}}}else if(8===s.nodeType)if(s.data===T)n.push({type:2,index:o});else{let e=-1;for(;-1!==(e=s.data.indexOf(C,e+1));)n.push({type:7,index:o}),e+=C.length-1}o++}}static createElement(e,t){const r=M.createElement("template");return r.innerHTML=e,r}}function Q(e,t,r=e,s){if(t===q)return t;let o=void 0!==s?r._$Co?.[s]:r._$Cl;const i=U(t)?void 0:t._$litDirective$;return o?.constructor!==i&&(o?._$AO?.(!1),void 0===i?o=void 0:(o=new i(e),o._$AT(e,r,s)),void 0!==s?(r._$Co??=[])[s]=o:r._$Cl=o),void 0!==o&&(t=Q(e,o._$AS(e,t.values),o,s)),t}class X{constructor(e,t){this._$AV=[],this._$AN=void 0,this._$AD=e,this._$AM=t}get parentNode(){return this._$AM.parentNode}get _$AU(){return this._$AM._$AU}u(e){const{el:{content:t},parts:r}=this._$AD,s=(e?.creationScope??M).importNode(t,!0);G.currentNode=s;let o=G.nextNode(),i=0,a=0,n=r[0];for(;void 0!==n;){if(i===n.index){let t;2===n.type?t=new ee(o,o.nextSibling,this,e):1===n.type?t=new n.ctor(o,n.name,n.strings,this,e):6===n.type&&(t=new ie(o,this,e)),this._$AV.push(t),n=r[++a]}i!==n?.index&&(o=G.nextNode(),i++)}return G.currentNode=M,s}p(e){let t=0;for(const r of this._$AV)void 0!==r&&(void 0!==r.strings?(r._$AI(e,r,t),t+=r.strings.length-2):r._$AI(e[t])),t++}}class ee{get _$AU(){return this._$AM?._$AU??this._$Cv}constructor(e,t,r,s){this.type=2,this._$AH=V,this._$AN=void 0,this._$AA=e,this._$AB=t,this._$AM=r,this.options=s,this._$Cv=s?.isConnected??!0}get parentNode(){let e=this._$AA.parentNode;const t=this._$AM;return void 0!==t&&11===e?.nodeType&&(e=t.parentNode),e}get startNode(){return this._$AA}get endNode(){return this._$AB}_$AI(e,t=this){e=Q(this,e,t),U(e)?e===V||null==e||""===e?(this._$AH!==V&&this._$AR(),this._$AH=V):e!==this._$AH&&e!==q&&this._(e):void 0!==e._$litType$?this.$(e):void 0!==e.nodeType?this.T(e):(e=>O(e)||"function"==typeof e?.[Symbol.iterator])(e)?this.k(e):this._(e)}O(e){return this._$AA.parentNode.insertBefore(e,this._$AB)}T(e){this._$AH!==e&&(this._$AR(),this._$AH=this.O(e))}_(e){this._$AH!==V&&U(this._$AH)?this._$AA.nextSibling.data=e:this.T(M.createTextNode(e)),this._$AH=e}$(e){const{values:t,_$litType$:r}=e,s="number"==typeof r?this._$AC(e):(void 0===r.el&&(r.el=Z.createElement(J(r.h,r.h[0]),this.options)),r);if(this._$AH?._$AD===s)this._$AH.p(t);else{const e=new X(s,this),r=e.u(this.options);e.p(t),this.T(r),this._$AH=e}}_$AC(e){let t=K.get(e.strings);return void 0===t&&K.set(e.strings,t=new Z(e)),t}k(e){O(this._$AH)||(this._$AH=[],this._$AR());const t=this._$AH;let r,s=0;for(const o of e)s===t.length?t.push(r=new ee(this.O(R()),this.O(R()),this,this.options)):r=t[s],r._$AI(o),s++;s<t.length&&(this._$AR(r&&r._$AB.nextSibling,s),t.length=s)}_$AR(e=this._$AA.nextSibling,t){for(this._$AP?.(!1,!0,t);e!==this._$AB;){const t=S(e).nextSibling;S(e).remove(),e=t}}setConnected(e){void 0===this._$AM&&(this._$Cv=e,this._$AP?.(e))}}class te{get tagName(){return this.element.tagName}get _$AU(){return this._$AM._$AU}constructor(e,t,r,s,o){this.type=1,this._$AH=V,this._$AN=void 0,this.element=e,this.name=t,this._$AM=s,this.options=o,r.length>2||""!==r[0]||""!==r[1]?(this._$AH=Array(r.length-1).fill(new String),this.strings=r):this._$AH=V}_$AI(e,t=this,r,s){const o=this.strings;let i=!1;if(void 0===o)e=Q(this,e,t,0),i=!U(e)||e!==this._$AH&&e!==q,i&&(this._$AH=e);else{const s=e;let a,n;for(e=o[0],a=0;a<o.length-1;a++)n=Q(this,s[r+a],t,a),n===q&&(n=this._$AH[a]),i||=!U(n)||n!==this._$AH[a],n===V?e=V:e!==V&&(e+=(n??"")+o[a+1]),this._$AH[a]=n}i&&!s&&this.j(e)}j(e){e===V?this.element.removeAttribute(this.name):this.element.setAttribute(this.name,e??"")}}class re extends te{constructor(){super(...arguments),this.type=3}j(e){this.element[this.name]=e===V?void 0:e}}class se extends te{constructor(){super(...arguments),this.type=4}j(e){this.element.toggleAttribute(this.name,!!e&&e!==V)}}class oe extends te{constructor(e,t,r,s,o){super(e,t,r,s,o),this.type=5}_$AI(e,t=this){if((e=Q(this,e,t,0)??V)===q)return;const r=this._$AH,s=e===V&&r!==V||e.capture!==r.capture||e.once!==r.once||e.passive!==r.passive,o=e!==V&&(r===V||s);s&&this.element.removeEventListener(this.name,this,r),o&&this.element.addEventListener(this.name,this,e),this._$AH=e}handleEvent(e){"function"==typeof this._$AH?this._$AH.call(this.options?.host??this.element,e):this._$AH.handleEvent(e)}}class ie{constructor(e,t,r){this.element=e,this.type=6,this._$AN=void 0,this._$AM=t,this.options=r}get _$AU(){return this._$AM._$AU}_$AI(e){Q(this,e)}}const ae=x.litHtmlPolyfillSupport;ae?.(Z,ee),(x.litHtmlVersions??=[]).push("3.3.3");const ne=globalThis;
/**
     * @license
     * Copyright 2017 Google LLC
     * SPDX-License-Identifier: BSD-3-Clause
     */class le extends k{constructor(){super(...arguments),this.renderOptions={host:this},this._$Do=void 0}createRenderRoot(){const e=super.createRenderRoot();return this.renderOptions.renderBefore??=e.firstChild,e}update(e){const t=this.render();this.hasUpdated||(this.renderOptions.isConnected=this.isConnected),super.update(e),this._$Do=((e,t,r)=>{const s=r?.renderBefore??t;let o=s._$litPart$;if(void 0===o){const e=r?.renderBefore??null;s._$litPart$=o=new ee(t.insertBefore(R(),e),e,void 0,r??{})}return o._$AI(e),o})(t,this.renderRoot,this.renderOptions)}connectedCallback(){super.connectedCallback(),this._$Do?.setConnected(!0)}disconnectedCallback(){super.disconnectedCallback(),this._$Do?.setConnected(!1)}render(){return q}}le._$litElement$=!0,le.finalized=!0,ne.litElementHydrateSupport?.({LitElement:le});const ce=ne.litElementPolyfillSupport;ce?.({LitElement:le}),(ne.litElementVersions??=[]).push("4.2.2");
/**
     * @license
     * Copyright 2017 Google LLC
     * SPDX-License-Identifier: BSD-3-Clause
     */
const de={attribute:!0,type:String,converter:w,reflect:!1,hasChanged:$},he=(e=de,t,r)=>{const{kind:s,metadata:o}=r;let i=globalThis.litPropertyMetadata.get(o);if(void 0===i&&globalThis.litPropertyMetadata.set(o,i=new Map),"setter"===s&&((e=Object.create(e)).wrapped=!0),i.set(r.name,e),"accessor"===s){const{name:s}=r;return{set(r){const o=t.get.call(this);t.set.call(this,r),this.requestUpdate(s,o,e,!0,r)},init(t){return void 0!==t&&this.C(s,void 0,e,t),t}}}if("setter"===s){const{name:s}=r;return function(r){const o=this[s];t.call(this,r),this.requestUpdate(s,o,e,!0,r)}}throw Error("Unsupported decorator location: "+s)};
/**
     * @license
     * Copyright 2017 Google LLC
     * SPDX-License-Identifier: BSD-3-Clause
     */function pe(e){return(t,r)=>"object"==typeof r?he(e,t,r):((e,t,r)=>{const s=t.hasOwnProperty(r);return t.constructor.createProperty(r,e),s?Object.getOwnPropertyDescriptor(t,r):void 0})(e,t,r)}
/**
     * @license
     * Copyright 2017 Google LLC
     * SPDX-License-Identifier: BSD-3-Clause
     */function ue(e){return pe({...e,state:!0,attribute:!1})}const fe=new Map,ge=[1e3,2e3,4e3,8e3,16e3,3e4];function me(e,t={}){const r=t.wsCtor??("undefined"!=typeof WebSocket?WebSocket:void 0),s=t.fetchImpl??("undefined"!=typeof fetch?fetch:void 0);let o=null,i="idle",a=null,n=0,l=null,c=null,d=!1,h=!1;const p=new Set,u=()=>{for(const e of p)try{e(o)}catch(e){"undefined"!=typeof console&&console.warn("[ecoflow] snapshot subscriber threw",e)}},f=e=>{i!==e&&(i=e,u())},g=()=>{null!=l&&(clearTimeout(l),l=null)},m=()=>{null!=c&&(clearTimeout(c),c=null)},v=()=>{if(g(),a){a.onopen=null,a.onmessage=null,a.onerror=null,a.onclose=null;try{a.close()}catch{}a=null}},b=()=>{if(d||!r)return;let t;g(),f("idle"===i?"connecting":"reconnecting");try{t=new r(function(e){let t=e.trim().replace(/\/$/,"");return/^https?:\/\//i.test(t)?t=t.replace(/^http/i,"ws"):/^wss?:\/\//i.test(t)||(t=`ws://${t}`),`${t}/ws`}(e))}catch{return void y()}a=t,t.onopen=()=>{d||a!==t||(n=0,f("open"),(()=>{if(h||!s)return;h=!0;const t=function(e,t){let r=e.trim().replace(/\/$/,"");return/^wss?:\/\//i.test(r)?r=r.replace(/^ws/i,"http"):/^https?:\/\//i.test(r)||(r=`http://${r}`),`${r}${t.startsWith("/")?t:`/${t}`}`}(e,"/api/snapshot");s(t).then(e=>e.ok?e.json():null).then(e=>{!d&&e&&null==o&&(o=e,u())}).catch(()=>{})})())},t.onmessage=e=>{if(!d&&a===t)try{const t=JSON.parse("string"==typeof e.data?e.data:"");t&&"snapshot"===t.type&&t.data&&(o=t.data,u())}catch{}},t.onerror=()=>{},t.onclose=()=>{a===t&&(a=null,d?f("closed"):y())}},y=()=>{if(d)return;f("reconnecting");const e=Math.min(n,ge.length-1);n+=1,l=setTimeout(()=>{l=null,b()},ge[e])},w={getSnapshot:()=>o,connectionState:()=>i,subscribe(t){m(),p.add(t);try{t(o)}catch(e){"undefined"!=typeof console&&console.warn("[ecoflow] snapshot subscriber threw",e)}return 1===p.size&&null==a&&"open"!==i&&"connecting"!==i&&"reconnecting"!==i&&b(),()=>{p.delete(t)&&0===p.size&&(m(),c=setTimeout(()=>{c=null,0===p.size&&(v(),n=0,h=!1,f("idle"),fe.get(e)===w&&fe.delete(e))},5e3))}},_destroy(){d=!0,m(),v(),f("closed"),p.clear(),fe.get(e)===w&&fe.delete(e)}};return w}class ve extends le{constructor(){super(...arguments),this.snapshot=null,this.connState="idle",this._unsubscribe=null,this._stateTimer=null}setConfig(e){if(!e)throw new Error("Invalid config");this.config={host:e.host||"http://homeassistant.local:8787",title:e.title||"EcoFlow Panel",refresh_seconds:e.refresh_seconds??30,type:e.type}}effectiveHost(){return this.config?.host||"http://homeassistant.local:8787"}connectedCallback(){super.connectedCallback();const e=function(e){const t=fe.get(e);if(t)return t;const r=me(e);return fe.set(e,r),r}(this.effectiveHost());this.connState=e.connectionState(),this._unsubscribe=e.subscribe(t=>{this.snapshot=t,this.connState=e.connectionState()})}disconnectedCallback(){super.disconnectedCallback(),this._unsubscribe&&this._unsubscribe(),this._unsubscribe=null,this._stateTimer&&(clearInterval(this._stateTimer),this._stateTimer=null)}getCardSize(){return 6}}t([pe({attribute:!1})],ve.prototype,"config",void 0),t([ue()],ve.prototype,"snapshot",void 0),t([ue()],ve.prototype,"connState",void 0);const be=n`
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
`,ye={};function we(e,t){for(const r of e.split("|"))ye[r.trim()]=t}function $e(e){const t=function(e){const t=function(e){return e.split("·")[0].split("(")[0].replace(/\s+/g," ").trim().toLowerCase()}(e);return t?ye[t]:void 0}(e);return t?F`<span class="ef-glossary"
    >${e}<span class="ef-tooltip" role="tooltip">${t}</span></span
  >`:e}we("soc|state of charge","State of charge — how full the battery is right now, 0–100%."),we("avg soc","Average state of charge across every online battery pack in the fleet."),we("soh|state of health|avg soh","State of health — measured usable capacity vs the pack’s original design capacity. A wear gauge; 100% = like-new."),we("ocv|open-circuit","Open-circuit voltage — the pack’s resting voltage with no load applied."),we("cell spread|worst cell spread|cell imbalance|cell spread now","Cell-voltage spread — the gap between the highest and lowest cell in a pack. A widening gap is an early sign of imbalance."),we("cell mean","Average voltage across all of the pack’s cells."),we("pack volt","Pack terminal voltage."),we("rep temp","Representative pack temperature reported by the BMS."),we("cell max|cell min","Hottest / coldest individual cell temperature in the pack."),we("cell temperatures","Per-cell temperature sensors inside the pack."),we("cell voltages","Per-cell voltage, each shown with its deviation from the pack mean."),we("mos max|mosfet temperatures|mosfet temps|mosfet","Power-MOSFET temperature — the BMS switching transistors."),we("board","BMS circuit-board temperature."),we("shunt","Current-shunt temperature — the precision resistor the BMS measures pack current across."),we("ptc heater temperatures|ptc heater temps|ptc","PTC heater temperature — keeps the cells warm enough to charge safely in the cold."),we("cycles","Equivalent full charge/discharge cycles the pack has completed — a measure of battery age."),we("lifetime throughput","Total energy ever charged into and discharged out of the pack."),we("capacity","Energy the battery can store, in kWh."),we("balancing|cells balancing","The BMS is equalizing cell voltages — routine housekeeping, no action needed."),we("hottest pack","The warmest pack across the fleet right now."),we("vitals","The pack’s key live readings at a glance."),we("pv|pv in|pv total|photovoltaic","Photovoltaic — solar-panel power."),we("pv high mppt|pv low mppt","Power from one of the DPU’s two solar strings (high- or low-voltage MPPT input)."),we("ac out|ac output","AC power flowing out of the inverter to your loads."),we("ac in","AC power flowing into the inverter — grid or generator charging."),we("ac out freq / v","Inverter AC output frequency (Hz) and voltage."),we("total in / out","Total power into and out of the DPU across every input and output."),we("battery v / a","Internal battery-bus voltage and current."),we("in|out","Power flowing in to / out of the device."),we("input|output","Power flowing into (charging) or out of (discharging) the pack."),we("panel load","Total power the SHP2’s circuits are drawing right now."),we("live contribution|live draw","Power this device is feeding/drawing right now."),we("voltage|current","Live electrical voltage / current at this input."),we("v × a","Voltage × current — instantaneous power, shown as a cross-check on the reported watts."),we("string ω","Effective resistance (volts ÷ amps) at the MPPT string’s operating point."),we("mppt|mppt temp|mppt hv|mppt lv|hv mppt|lv mppt","MPPT — the solar charge controller (Maximum Power Point Tracker). Each DPU has two: a high-voltage and a low-voltage string input."),we("hv channels|lv channels","High-/low-voltage MPPT solar string inputs — one of each per DPU."),we("ghi","Global Horizontal Irradiance — total sunlight energy on a flat surface (W/m²); the raw “how sunny” number the forecast is built from."),we("producing now","Solar power being generated right now."),we("peak today","The highest solar power reached so far today."),we("coefficient|peak response|response coefficient","Learned response coefficient — watts of PV produced per W/m² of sunlight. Captures panel size, orientation, shading and inverter clipping."),we("strongest hour","The hour of day your arrays convert sunlight to power most efficiently — reveals their orientation."),we("observed peak pv","The highest PV output actually recorded at this hour-of-day."),we("soiling","Dust/pollen on the panels cutting output. Detected by comparing clear-sky production to the cleanest day on record."),we("output drop","How far clear-sky solar output has fallen below the clean-panel baseline — the soiling indicator."),we("backup|backup pool","SHP2 backup pool — the combined battery the Smart Home Panel draws on."),we("backup %","Backup-pool state of charge, trended over the last hour."),we("reserve floor|backup reserve|reserve","Reserve floor — the state of charge held back for backup. Loads begin shedding below it."),we("solar reserve","Target state of charge to keep in reserve specifically when running on solar."),we("mid-priority floor","The SoC at which mid-priority circuits are cut to protect the battery."),we("charge power","Power currently flowing into the battery."),we("charge time","Estimated time to fully charge the battery."),we("rated power","The device’s rated maximum power output."),we("ems bat temp","Battery temperature as reported by the SHP2’s energy-management system."),we("hw link","Hardware (wired) link status between the SHP2 and this DPU."),we("load-shed strategy","The SHP2’s automatic plan for dropping circuits as the battery depletes."),we("smart backup mode","The SHP2’s backup-behaviour mode setting."),we("charge schedule","The SHP2’s time-of-use scheduled charging windows."),we("error code|direct errors|shp2 errors","Device-reported error code — 0 means no fault."),we("charging power","Power the EV charger is drawing, over the last 24 hours."),we("sessions today","Charging sessions detected today — a sustained draw above 1 kW."),we("host dpu|dpu battery","The Delta Pro Ultra the EV charger is wired to — that DPU’s AC output equals the charging draw."),we("direct telemetry|direct evse telemetry","Raw data straight from the device over MQTT, rather than inferred."),we("solar next 24 h|solar next 24h","Projected solar production, from the cloud forecast run through your learned array model."),we("forecast load|forecast load 24 h|typical solar / day","Projected household load from the typical-day consumption curve."),we("forecast pv","Projected PV output for this hour."),we("projected low soc","The lowest the battery is forecast to reach over the next 24 hours."),we("cloud cover","Forecast cloud cover — what derates the solar prediction each hour."),we("outlook","At-a-glance battery comfort vs the reserve floor: Comfortable, Watch or Tight."),we("history depth","Days of recorded data behind the forecast and learned models — they sharpen as it grows."),we("confidence","How trustworthy the learned model is, based on how many samples it has."),we("z-score|peer z-score","Modified z-score — how many robust deviations a reading sits from normal. Higher = more anomalous; ≥ 3.5 flags, ≥ 5 warns."),we("fit quality|fit r²","R-squared — how well the trend line fits the data, 0–1. Higher means a more trustworthy projection."),we("samples|regression samples","How many data points the estimate is built from — more points, more reliable."),we("sibling median","The median reading across the pack’s four siblings — the “normal” this pack is compared against."),we("this pack","This pack’s current reading."),we("deviation","How far this reading sits from the expected/normal value."),we("baseline window","The span of history and number of samples behind the self-baseline."),we("decline rate|rise rate","How fast the value is changing, per unit time."),we("end-of-life|eol|projected eol|reaches 80%","End of life — the 80%-SoH point where a pack has lost a fifth of its original capacity; the conventional LFP replacement mark."),we("fade rate|fade / yr|avg fade rate","How fast measured capacity (State of Health) is falling — SoH percentage points lost per year."),we("service left|years left|years to eol","Projected years of service remaining before the pack reaches the 80% end-of-life threshold."),we("eol threshold","The State of Health at which a pack counts as end-of-life — conventionally 80% for LFP cells."),we("packs projecting","How many packs have a firm enough SoH trend to project an end-of-life date."),we("soonest eol","The pack across the fleet projected to reach end-of-life first."),we("cycles at eol","Projected equivalent full-cycle count by the time the pack reaches end-of-life."),we("data span","Days of recorded history the projection is regressed over."),we("projection notes","Plain-language end-of-life verdict for each pack with a firm fade trend."),we("trend","Whether a pack has a projected fade trend, is stable, is still learning, or has no data yet."),we("critical","Critical — an immediate problem that needs attention now."),we("warnings|warning","Warning — something to investigate soon."),we("informational|info","Informational — noted for awareness, not urgent."),we("anomalies","Things unusual right now — flagged by peer comparison and self-baseline."),we("forecasts","Where things are heading — runtime, degradation and day-ahead projections."),we("actionable","Critical + warning items that may need attention."),we("recently cleared","Alerts that were raised and have since resolved, with how long each lasted."),we("today","Energy totals since local midnight."),we("solar produced","Total solar energy harvested today."),we("batteries","Net battery energy today — negative means net charged, positive means net discharged.");const _e=e=>null==e?"—":Math.abs(e)>=1e3?`${(e/1e3).toFixed(2)} kW`:`${Math.round(e)} W`,ke=(e,t=0)=>null==e?"—":`${e.toFixed(t)}%`;class xe extends le{constructor(){super(...arguments),this.tone="neutral"}render(){return F`<slot></slot>`}}xe.styles=[be,n`
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
    `],t([pe({reflect:!0})],xe.prototype,"tone",void 0),customElements.get("ef-badge")||customElements.define("ef-badge",xe);class Se extends le{constructor(){super(...arguments),this.label="",this.value="",this.unit=""}render(){return F`
      <div class="label"><slot name="label">${this.label}</slot></div>
      <div class="value-line">
        <span class="value"><slot name="value">${this.value}</slot></span>
        ${this.unit?F`<span class="unit">${this.unit}</span>`:null}
      </div>
      <slot></slot>
    `}}Se.styles=[be,n`
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
    `],t([pe()],Se.prototype,"label",void 0),t([pe()],Se.prototype,"value",void 0),t([pe()],Se.prototype,"unit",void 0),customElements.get("ef-tile")||customElements.define("ef-tile",Se);class Ae extends le{constructor(){super(...arguments),this.title=""}render(){return F`
      <header>
        <div class="title"><slot name="title">${this.title}</slot></div>
        <div class="header-extra"><slot name="header"></slot></div>
      </header>
      <div class="body"><slot></slot></div>
    `}}Ae.styles=[be,n`
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
    `],t([pe()],Ae.prototype,"title",void 0),customElements.get("ef-section")||customElements.define("ef-section",Ae);return e.EcoflowStrategyCard=class extends ve{constructor(){super(...arguments),this.plan={data:null,stale:!1},this._httpTimer=null}connectedCallback(){super.connectedCallback(),this._fetchPlan();const e=Math.max(30,this.config?.refresh_seconds??60);this._httpTimer=setInterval(()=>{this._fetchPlan()},1e3*e)}disconnectedCallback(){super.disconnectedCallback(),this._httpTimer&&(clearInterval(this._httpTimer),this._httpTimer=null)}async _fetchPlan(){try{const e=this.effectiveHost().replace(/\/$/,"")+"/api/dispatch-plan",t=await fetch(e);if(!t.ok)throw new Error(`HTTP ${t.status}`);this.plan={data:await t.json(),stale:!1}}catch{this.plan={...this.plan,stale:!0}}}connTone(e){return"open"===e?"ok":"connecting"===e||"reconnecting"===e?"warn":"closed"===e?"bad":"neutral"}connLabel(e){return"open"===e?"live":"connecting"===e?"linking":"reconnecting"===e?"reconnecting":"closed"===e?"offline":"idle"}findShp2(){const e=this.snapshot;if(!e)return null;for(const t of Object.values(e.devices))if("shp2"===t.projection?.kind)return t;return null}rankTier(e,t){if(null==e)return"neutral";if(t<=1)return"ok";const r=(e-1)/(t-1);return r<.34?"ok":r<.67?"warn":"bad"}rankLabel(e,t){if(null==e)return"unranked";const r=this.rankTier(e,t);return"ok"===r?"essential":"warn"===r?"standard":"first to shed"}fmtClock(e){const t=Math.floor(e/60)%24,r=t<12?"a":"p";return`${t%12==0?12:t%12}:${String(e%60).padStart(2,"0")}${r}`}taskLabel(e){return e?/charge/i.test(e)?"Scheduled charge":/discharge/i.test(e)?"Scheduled discharge":e:"—"}modeLabel(e){return e?/every_day/i.test(e)?"Every day":/week/i.test(e)?"Weekly":/once/i.test(e)?"Once":e.replace(/STARTEGY_|STRATEGY_/i,"").replace(/_/g," ").toLowerCase():"—"}actionLabel(e){switch(e){case"charge_from_pv":return"Charge from solar";case"discharge_to_load":return"Discharge to load";case"grid_import":return"Import from grid";case"hold":return"Hold"}}actionTone(e){switch(e){case"charge_from_pv":return"ok";case"discharge_to_load":return"info";case"grid_import":return"warn";case"hold":return"neutral"}}fmtHourTs(e){const t=new Date(e).getHours();return`${t%12==0?12:t%12}${t<12?"a":"p"}`}fmtDollars(e){if(!Number.isFinite(e))return"—";return`${e>=0?"+":""}$${e.toFixed(2)}`}render(){const e=this.snapshot,t=this.config?.title??"Strategy";if(!e)return F`<ha-card>
        ${this.renderHeader(t,null,null)}
        <div class="skeleton"><span class="dot"></span>Connecting to add-on…</div>
      </ha-card>`;const r=this.findShp2();if(!r||!r.projection)return F`<ha-card>
        ${this.renderHeader(t,null,null)}
        <div class="no-data">
          SHP2 not available — strategy view needs the Smart Home Panel online.
        </div>
      </ha-card>`;const s=r.projection.strategy;return F`<ha-card>
      ${this.renderHeader(t,r,s)}
      ${this.renderStrategyTiles(s)}
      ${this.renderPriorities(r.projection.pairedCircuits)}
      ${this.renderTou(s)}
      ${this.renderRecommendations()}
    </ha-card>`}renderHeader(e,t,r){const s=r?F`<ef-badge tone=${r.loadShedEnabled?"ok":r.loadShedConfigured?"neutral":"warn"}>
          ${r.loadShedEnabled?"load-shed active":r.loadShedConfigured?"configured · inactive":"not configured"}
        </ef-badge>`:V;return F`<div class="header">
      <div>
        <div class="title">${e}</div>
        <div class="subtitle" title="Edit TOU/priorities in the add-on options or the EcoFlow app">
          ${t?t.deviceName:this.effectiveHost()} · read-only · edit in add-on
        </div>
      </div>
      <div class="badges">
        ${s}
        <ef-badge tone=${this.connTone(this.connState)}>${this.connLabel(this.connState)}</ef-badge>
      </div>
    </div>`}renderStrategyTiles(e){return F`<ef-section .title=${"Strategy"}>
      <div class="strategy-tiles">
        <ef-tile
          label="Mid-priority floor"
          value=${ke(e.midPriorityDischargeFloorSoc)}
        >
          <span slot="label">${$e("mid-priority floor")}</span>
          <span>mid loads cut at this SoC</span>
        </ef-tile>
        <ef-tile label="Backup reserve" value=${ke(e.backupReserveSoc)}>
          <span slot="label">${$e("reserve floor")}</span>
          <span>${e.backupReserveEnabled?"reserve enabled":"reserve disabled"}</span>
        </ef-tile>
        <ef-tile label="Solar reserve" value=${ke(e.solarBackupReserveSoc)}>
          <span slot="label">${$e("solar reserve")}</span>
          <span>target SoC on solar</span>
        </ef-tile>
        <ef-tile label="Smart backup" value=${String(e.smartBackupMode??"—")}>
          <span slot="label">${$e("smart backup mode")}</span>
          <span>backup ${e.backupMode??"—"} · overload ${e.overloadMode??"—"}</span>
        </ef-tile>
      </div>
      ${!e.loadShedEnabled&&e.loadShedConfigured?F`<div class="strategy-hint full">
            Priorities below are configured but the automatic ${$e("load-shed strategy")} is
            currently switched off in the SHP2. They define the intended shed order when enabled —
            lowest-ranked circuits drop first as the battery depletes.
          </div>`:V}
    </ef-section>`}renderPriorities(e){const t=e.filter(e=>null!=e.loadPriority).sort((e,t)=>(e.loadPriority??999)-(t.loadPriority??999)),r=e.filter(e=>null==e.loadPriority),s=t.length;return 0===t.length&&0===r.length?F`<ef-section .title=${"Circuit priorities"}>
        <div class="no-data">No paired circuits reported by the SHP2.</div>
      </ef-section>`:F`<ef-section .title=${"Circuit priorities"}>
      <div class="pri-list">
        ${t.map((e,t)=>this.renderPriorityRow(e,t+1,s))}
        ${r.map(e=>this.renderPriorityRow(e,null,s))}
      </div>
      <div class="pri-help full">
        #1 = highest priority (last to be shed, kept powered longest). Higher numbers shed earlier
        when ${$e("backup")} runs low.
      </div>
    </ef-section>`}renderPriorityRow(e,t,r){const s=this.rankTier(t,r),o=this.rankLabel(t,r),i=(e.watts??0)>1,a=e.isSplitPhase?`ch${e.primaryCh}+${e.secondaryCh} · 240V`:`ch${e.primaryCh}`;return F`<div class="pri-row" data-tier=${s}>
      <span class="pri-rank" data-tier=${s}>${t??"—"}</span>
      <div>
        <div class="pri-name" title=${e.name}>${e.name}</div>
        <span class="pri-meta"
          >${a} · ${e.breakerAmps??"—"}A · raw priority ${e.loadPriority??"—"}</span
        >
      </div>
      <span class="pri-watts ${i?"active":""}">${_e(e.watts)}</span>
      <ef-badge tone=${"neutral"===s?"neutral":s}>${o}</ef-badge>
    </div>`}renderTou(e){const t=e.timeTask,r=t?F`<ef-badge slot="header" tone=${t.isEnabled?"ok":"neutral"}
          >${t.isEnabled?"enabled":"disabled"}</ef-badge
        >`:F`<ef-badge slot="header" tone="neutral">no task</ef-badge>`;return t?F`<ef-section .title=${"Charge schedule"}>
      ${r}
      <div class="tou-tiles">
        <ef-tile label="Task" value=${this.taskLabel(t.type)}>
          <span slot="label">${$e("charge schedule")}</span>
        </ef-tile>
        <ef-tile label="Repeat" value=${this.modeLabel(t.timeMode)}></ef-tile>
        <ef-tile label="Target SoC" value=${ke(t.chargeCeilingSoc)}>
          <span>floor ${ke(t.chargeFloorSoc)}</span>
        </ef-tile>
        <ef-tile label="Charge power" value=${_e(t.chargeWatts)}>
          <span slot="label">${$e("charge power")}</span>
        </ef-tile>
      </div>
      ${this.renderDayTimeline(t.windows)}
      <div class="tou-hint full">
        ${0===t.windows.length?"No active window in the schedule bitmap.":F`Active window${t.windows.length>1?"s":""}:
              ${t.windows.map(e=>`${this.fmtClock(e.startMinute)}–${this.fmtClock(e.endMinute)}`).join(", ")}
              · ${t.slotMinutes}-min resolution`}
        ${t.isEnabled?V:" · task currently disabled, so this window is not being acted on."}
      </div>
    </ef-section>`:F`<ef-section .title=${"Charge schedule"}>
        ${r}
        <div class="no-data">
          No scheduled charge/discharge task configured on the SHP2.
        </div>
      </ef-section>`}renderDayTimeline(e){const t=1440,r=new Date,s=60*r.getHours()+r.getMinutes();return F`<div class="full">
      <div class="tou-timeline">
        ${Array.from({length:23},(e,t)=>t+1).map(e=>F`<div class="tou-grid" style="left:${e/24*100}%"></div>`)}
        ${e.map(e=>F`<div
            class="tou-window"
            style="left:${e.startMinute/t*100}%;width:${(e.endMinute-e.startMinute)/t*100}%"
          ></div>`)}
        <div class="tou-now" style="left:${s/t*100}%" title="now"></div>
      </div>
      <div class="tou-ticks">
        ${["12a","4a","8a","12p","4p","8p","12a"].map(e=>F`<span>${e}</span>`)}
      </div>
    </div>`}renderRecommendations(){const e=this.plan.data,t=this.plan.stale;if(!e&&!t)return F`<ef-section .title=${"Recommendations"}>
        <div class="no-data">Computing dispatch plan…</div>
      </ef-section>`;if(!e)return F`<ef-section .title=${"Recommendations"}>
        <ef-badge slot="header" tone="warn">stale data</ef-badge>
        <div class="no-data">Dispatch plan unavailable.</div>
      </ef-section>`;const r=Date.now(),s=e.hours.filter(e=>e.ts>=r-36e5&&"hold"!==e.action),o=this.groupConsecutive(s).slice(0,4),i=e.estimatedSavingsDollars;return 0===o.length?F`<ef-section .title=${"Recommendations"}>
        ${t?F`<ef-badge slot="header" tone="warn">stale data</ef-badge>`:V}
        <div class="no-data">
          No active dispatch actions in the next 24 hours — hold and self-consume.
        </div>
        ${i>0?F`<div class="strategy-hint full">
              Plan saves ~${this.fmtDollars(i)} vs all-grid baseline.
            </div>`:V}
      </ef-section>`:F`<ef-section .title=${"Recommendations"}>
      ${t?F`<ef-badge slot="header" tone="warn">stale data</ef-badge>`:V}
      <div class="rec-list">
        ${o.map(e=>this.renderRecRow(e))}
      </div>
      ${0!==i?F`<div class="strategy-hint full">
            Plan saves ~${this.fmtDollars(i)} vs all-grid baseline · target ${e.targetPrePeakSocPct}%
            SoC before peak.
          </div>`:V}
    </ef-section>`}groupConsecutive(e){const t=[];for(const r of e){const e=t[t.length-1],s=36e5;e&&e.action===r.action&&r.ts-e.endTs<=s+1?(e.endTs=r.ts+s,e.totalFlowKwh+=r.flowW/1e3,e.totalCostDollars+=r.hourlyCostDollars,e.onPeak=e.onPeak||r.onPeak,e.finalSocPct=r.socEndPct):t.push({startTs:r.ts,endTs:r.ts+s,action:r.action,totalFlowKwh:r.flowW/1e3,totalCostDollars:r.hourlyCostDollars,onPeak:r.onPeak,finalSocPct:r.socEndPct})}return t}renderRecRow(e){const t=this.actionTone(e.action),r=this.actionLabel(e.action),s=`${this.fmtHourTs(e.startTs)}–${this.fmtHourTs(e.endTs)}`,o="grid_import"===e.action?-e.totalCostDollars:0,i=`${Math.round(10*Math.abs(e.totalFlowKwh))/10} kWh · ends ${e.finalSocPct.toFixed(0)}% SoC${e.onPeak?" · on-peak":""}`;return F`<div class="rec-row">
      <span class="rec-time">${s}</span>
      <div class="rec-detail">
        <ef-badge tone=${t}>${r}</ef-badge>
        <span class="sub">${i}</span>
      </div>
      <span class="rec-savings">
        ${"grid_import"===e.action?F`<span style="color:var(--ef-warn)">${this.fmtDollars(e.totalCostDollars)}</span>`:o>0?F`<span style="color:var(--ef-ok)">${this.fmtDollars(o)}</span>`:V}
      </span>
    </div>`}getCardSize(){return 8}},e.EcoflowStrategyCard.styles=[be,n`
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
        flex-wrap: wrap;
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
        0%,
        100% {
          opacity: 0.3;
        }
        50% {
          opacity: 1;
        }
      }
      .strategy-tiles {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
        gap: 8px;
        width: 100%;
      }
      .full {
        width: 100%;
      }
      .strategy-hint {
        font-size: 0.7rem;
        color: var(--ef-muted);
        line-height: 1.4;
      }
      /* ── Circuit priorities ── */
      .pri-list {
        display: flex;
        flex-direction: column;
        gap: 4px;
        width: 100%;
      }
      .pri-row {
        display: grid;
        grid-template-columns: 32px 1fr auto auto;
        align-items: center;
        gap: 8px;
        padding: 6px 8px;
        border: 1px solid var(--ef-line);
        border-radius: 8px;
        background: color-mix(in srgb, var(--ef-panel) 96%, transparent);
        font-size: 0.82rem;
        line-height: 1.2;
      }
      .pri-row[data-tier='ok'] {
        border-left: 3px solid var(--ef-ok);
      }
      .pri-row[data-tier='warn'] {
        border-left: 3px solid var(--ef-warn);
      }
      .pri-row[data-tier='bad'] {
        border-left: 3px solid var(--ef-bad);
      }
      .pri-row[data-tier='neutral'] {
        border-left: 3px solid var(--ef-line);
        opacity: 0.7;
      }
      .pri-rank {
        font-weight: 700;
        font-variant-numeric: tabular-nums;
        text-align: center;
        font-size: 1rem;
      }
      .pri-rank[data-tier='ok'] {
        color: var(--ef-ok);
      }
      .pri-rank[data-tier='warn'] {
        color: var(--ef-warn);
      }
      .pri-rank[data-tier='bad'] {
        color: var(--ef-bad);
      }
      .pri-name {
        font-weight: 500;
        color: var(--ef-ink);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .pri-meta {
        display: block;
        font-size: 0.65rem;
        color: var(--ef-muted);
        font-weight: 400;
      }
      .pri-watts {
        font-variant-numeric: tabular-nums;
        text-align: right;
        color: var(--ef-muted);
      }
      .pri-watts.active {
        color: var(--ef-ok);
        font-weight: 600;
      }
      .pri-help {
        font-size: 0.7rem;
        color: var(--ef-muted);
        line-height: 1.4;
        margin-top: 4px;
      }
      /* ── TOU schedule ── */
      .tou-tiles {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
        gap: 8px;
        width: 100%;
      }
      .tou-timeline {
        position: relative;
        height: 32px;
        background: color-mix(in srgb, var(--ef-panel) 90%, transparent);
        border: 1px solid var(--ef-line);
        border-radius: 8px;
        overflow: hidden;
        width: 100%;
      }
      .tou-grid {
        position: absolute;
        top: 0;
        bottom: 0;
        border-left: 1px solid color-mix(in srgb, var(--ef-line) 60%, transparent);
      }
      .tou-window {
        position: absolute;
        top: 0;
        bottom: 0;
        background: color-mix(in srgb, var(--ef-accent) 30%, transparent);
        border-left: 1px solid var(--ef-accent);
        border-right: 1px solid var(--ef-accent);
      }
      .tou-now {
        position: absolute;
        top: 0;
        bottom: 0;
        width: 1px;
        background: var(--ef-bad);
      }
      .tou-ticks {
        display: flex;
        justify-content: space-between;
        font-size: 0.62rem;
        color: var(--ef-muted);
        margin-top: 2px;
      }
      .tou-hint {
        font-size: 0.7rem;
        color: var(--ef-muted);
        line-height: 1.4;
        margin-top: 4px;
      }
      /* ── Recommendations ── */
      .rec-list {
        display: flex;
        flex-direction: column;
        gap: 6px;
        width: 100%;
      }
      .rec-row {
        display: grid;
        grid-template-columns: auto 1fr auto;
        gap: 8px;
        align-items: center;
        padding: 6px 10px;
        border: 1px solid var(--ef-line);
        border-radius: 8px;
        background: color-mix(in srgb, var(--ef-panel) 96%, transparent);
        font-size: 0.82rem;
      }
      .rec-time {
        font-variant-numeric: tabular-nums;
        font-weight: 600;
        color: var(--ef-ink);
        min-width: 56px;
      }
      .rec-detail {
        color: var(--ef-ink);
        line-height: 1.35;
      }
      .rec-detail .sub {
        display: block;
        font-size: 0.7rem;
        color: var(--ef-muted);
        font-weight: 400;
      }
      .rec-savings {
        font-variant-numeric: tabular-nums;
        font-weight: 600;
      }
      .no-data {
        font-size: 0.78rem;
        color: var(--ef-muted);
        padding: 4px 0;
      }
    `],t([ue()],e.EcoflowStrategyCard.prototype,"plan",void 0),e.EcoflowStrategyCard=t([(e=>(t,r)=>{void 0!==r?r.addInitializer(()=>{customElements.define(e,t)}):customElements.define(e,t)})("ecoflow-strategy-card")],e.EcoflowStrategyCard),window.customCards=window.customCards||[],window.customCards.push({type:"ecoflow-strategy-card",name:"EcoFlow Strategy Card",description:"SHP2 load-shed priorities, TOU schedule and dispatch recommendations (read-only)"}),e}({});
//# sourceMappingURL=ecoflow-strategy-card.js.map
