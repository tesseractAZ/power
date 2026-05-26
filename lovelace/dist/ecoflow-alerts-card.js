var EcoflowAlertsCard=function(e){"use strict";function t(e,t,s,r){var o,i=arguments.length,a=i<3?t:null===r?r=Object.getOwnPropertyDescriptor(t,s):r;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)a=Reflect.decorate(e,t,s,r);else for(var n=e.length-1;n>=0;n--)(o=e[n])&&(a=(i<3?o(a):i>3?o(t,s,a):o(t,s))||a);return i>3&&a&&Object.defineProperty(t,s,a),a}"function"==typeof SuppressedError&&SuppressedError;
/**
     * @license
     * Copyright 2019 Google LLC
     * SPDX-License-Identifier: BSD-3-Clause
     */
const s=globalThis,r=s.ShadowRoot&&(void 0===s.ShadyCSS||s.ShadyCSS.nativeShadow)&&"adoptedStyleSheets"in Document.prototype&&"replace"in CSSStyleSheet.prototype,o=Symbol(),i=new WeakMap;let a=class{constructor(e,t,s){if(this._$cssResult$=!0,s!==o)throw Error("CSSResult is not constructable. Use `unsafeCSS` or `css` instead.");this.cssText=e,this.t=t}get styleSheet(){let e=this.o;const t=this.t;if(r&&void 0===e){const s=void 0!==t&&1===t.length;s&&(e=i.get(t)),void 0===e&&((this.o=e=new CSSStyleSheet).replaceSync(this.cssText),s&&i.set(t,e))}return e}toString(){return this.cssText}};const n=(e,...t)=>{const s=1===e.length?e[0]:t.reduce((t,s,r)=>t+(e=>{if(!0===e._$cssResult$)return e.cssText;if("number"==typeof e)return e;throw Error("Value passed to 'css' function must be a 'css' function result: "+e+". Use 'unsafeCSS' to pass non-literal values, but take care to ensure page security.")})(s)+e[r+1],e[0]);return new a(s,e,o)},l=r?e=>e:e=>e instanceof CSSStyleSheet?(e=>{let t="";for(const s of e.cssRules)t+=s.cssText;return(e=>new a("string"==typeof e?e:e+"",void 0,o))(t)})(e):e,{is:c,defineProperty:d,getOwnPropertyDescriptor:h,getOwnPropertyNames:p,getOwnPropertySymbols:u,getPrototypeOf:f}=Object,g=globalThis,m=g.trustedTypes,v=m?m.emptyScript:"",y=g.reactiveElementPolyfillSupport,b=(e,t)=>e,w={toAttribute(e,t){switch(t){case Boolean:e=e?v:null;break;case Object:case Array:e=null==e?e:JSON.stringify(e)}return e},fromAttribute(e,t){let s=e;switch(t){case Boolean:s=null!==e;break;case Number:s=null===e?null:Number(e);break;case Object:case Array:try{s=JSON.parse(e)}catch(e){s=null}}return s}},$=(e,t)=>!c(e,t),_={attribute:!0,type:String,converter:w,reflect:!1,useDefault:!1,hasChanged:$};
/**
     * @license
     * Copyright 2017 Google LLC
     * SPDX-License-Identifier: BSD-3-Clause
     */Symbol.metadata??=Symbol("metadata"),g.litPropertyMetadata??=new WeakMap;let A=class extends HTMLElement{static addInitializer(e){this._$Ei(),(this.l??=[]).push(e)}static get observedAttributes(){return this.finalize(),this._$Eh&&[...this._$Eh.keys()]}static createProperty(e,t=_){if(t.state&&(t.attribute=!1),this._$Ei(),this.prototype.hasOwnProperty(e)&&((t=Object.create(t)).wrapped=!0),this.elementProperties.set(e,t),!t.noAccessor){const s=Symbol(),r=this.getPropertyDescriptor(e,s,t);void 0!==r&&d(this.prototype,e,r)}}static getPropertyDescriptor(e,t,s){const{get:r,set:o}=h(this.prototype,e)??{get(){return this[t]},set(e){this[t]=e}};return{get:r,set(t){const i=r?.call(this);o?.call(this,t),this.requestUpdate(e,i,s)},configurable:!0,enumerable:!0}}static getPropertyOptions(e){return this.elementProperties.get(e)??_}static _$Ei(){if(this.hasOwnProperty(b("elementProperties")))return;const e=f(this);e.finalize(),void 0!==e.l&&(this.l=[...e.l]),this.elementProperties=new Map(e.elementProperties)}static finalize(){if(this.hasOwnProperty(b("finalized")))return;if(this.finalized=!0,this._$Ei(),this.hasOwnProperty(b("properties"))){const e=this.properties,t=[...p(e),...u(e)];for(const s of t)this.createProperty(s,e[s])}const e=this[Symbol.metadata];if(null!==e){const t=litPropertyMetadata.get(e);if(void 0!==t)for(const[e,s]of t)this.elementProperties.set(e,s)}this._$Eh=new Map;for(const[e,t]of this.elementProperties){const s=this._$Eu(e,t);void 0!==s&&this._$Eh.set(s,e)}this.elementStyles=this.finalizeStyles(this.styles)}static finalizeStyles(e){const t=[];if(Array.isArray(e)){const s=new Set(e.flat(1/0).reverse());for(const e of s)t.unshift(l(e))}else void 0!==e&&t.push(l(e));return t}static _$Eu(e,t){const s=t.attribute;return!1===s?void 0:"string"==typeof s?s:"string"==typeof e?e.toLowerCase():void 0}constructor(){super(),this._$Ep=void 0,this.isUpdatePending=!1,this.hasUpdated=!1,this._$Em=null,this._$Ev()}_$Ev(){this._$ES=new Promise(e=>this.enableUpdating=e),this._$AL=new Map,this._$E_(),this.requestUpdate(),this.constructor.l?.forEach(e=>e(this))}addController(e){(this._$EO??=new Set).add(e),void 0!==this.renderRoot&&this.isConnected&&e.hostConnected?.()}removeController(e){this._$EO?.delete(e)}_$E_(){const e=new Map,t=this.constructor.elementProperties;for(const s of t.keys())this.hasOwnProperty(s)&&(e.set(s,this[s]),delete this[s]);e.size>0&&(this._$Ep=e)}createRenderRoot(){const e=this.shadowRoot??this.attachShadow(this.constructor.shadowRootOptions);return((e,t)=>{if(r)e.adoptedStyleSheets=t.map(e=>e instanceof CSSStyleSheet?e:e.styleSheet);else for(const r of t){const t=document.createElement("style"),o=s.litNonce;void 0!==o&&t.setAttribute("nonce",o),t.textContent=r.cssText,e.appendChild(t)}})(e,this.constructor.elementStyles),e}connectedCallback(){this.renderRoot??=this.createRenderRoot(),this.enableUpdating(!0),this._$EO?.forEach(e=>e.hostConnected?.())}enableUpdating(e){}disconnectedCallback(){this._$EO?.forEach(e=>e.hostDisconnected?.())}attributeChangedCallback(e,t,s){this._$AK(e,s)}_$ET(e,t){const s=this.constructor.elementProperties.get(e),r=this.constructor._$Eu(e,s);if(void 0!==r&&!0===s.reflect){const o=(void 0!==s.converter?.toAttribute?s.converter:w).toAttribute(t,s.type);this._$Em=e,null==o?this.removeAttribute(r):this.setAttribute(r,o),this._$Em=null}}_$AK(e,t){const s=this.constructor,r=s._$Eh.get(e);if(void 0!==r&&this._$Em!==r){const e=s.getPropertyOptions(r),o="function"==typeof e.converter?{fromAttribute:e.converter}:void 0!==e.converter?.fromAttribute?e.converter:w;this._$Em=r;const i=o.fromAttribute(t,e.type);this[r]=i??this._$Ej?.get(r)??i,this._$Em=null}}requestUpdate(e,t,s,r=!1,o){if(void 0!==e){const i=this.constructor;if(!1===r&&(o=this[e]),s??=i.getPropertyOptions(e),!((s.hasChanged??$)(o,t)||s.useDefault&&s.reflect&&o===this._$Ej?.get(e)&&!this.hasAttribute(i._$Eu(e,s))))return;this.C(e,t,s)}!1===this.isUpdatePending&&(this._$ES=this._$EP())}C(e,t,{useDefault:s,reflect:r,wrapped:o},i){s&&!(this._$Ej??=new Map).has(e)&&(this._$Ej.set(e,i??t??this[e]),!0!==o||void 0!==i)||(this._$AL.has(e)||(this.hasUpdated||s||(t=void 0),this._$AL.set(e,t)),!0===r&&this._$Em!==e&&(this._$Eq??=new Set).add(e))}async _$EP(){this.isUpdatePending=!0;try{await this._$ES}catch(e){Promise.reject(e)}const e=this.scheduleUpdate();return null!=e&&await e,!this.isUpdatePending}scheduleUpdate(){return this.performUpdate()}performUpdate(){if(!this.isUpdatePending)return;if(!this.hasUpdated){if(this.renderRoot??=this.createRenderRoot(),this._$Ep){for(const[e,t]of this._$Ep)this[e]=t;this._$Ep=void 0}const e=this.constructor.elementProperties;if(e.size>0)for(const[t,s]of e){const{wrapped:e}=s,r=this[t];!0!==e||this._$AL.has(t)||void 0===r||this.C(t,void 0,s,r)}}let e=!1;const t=this._$AL;try{e=this.shouldUpdate(t),e?(this.willUpdate(t),this._$EO?.forEach(e=>e.hostUpdate?.()),this.update(t)):this._$EM()}catch(t){throw e=!1,this._$EM(),t}e&&this._$AE(t)}willUpdate(e){}_$AE(e){this._$EO?.forEach(e=>e.hostUpdated?.()),this.hasUpdated||(this.hasUpdated=!0,this.firstUpdated(e)),this.updated(e)}_$EM(){this._$AL=new Map,this.isUpdatePending=!1}get updateComplete(){return this.getUpdateComplete()}getUpdateComplete(){return this._$ES}shouldUpdate(e){return!0}update(e){this._$Eq&&=this._$Eq.forEach(e=>this._$ET(e,this[e])),this._$EM()}updated(e){}firstUpdated(e){}};A.elementStyles=[],A.shadowRootOptions={mode:"open"},A[b("elementProperties")]=new Map,A[b("finalized")]=new Map,y?.({ReactiveElement:A}),(g.reactiveElementVersions??=[]).push("2.1.2");
/**
     * @license
     * Copyright 2017 Google LLC
     * SPDX-License-Identifier: BSD-3-Clause
     */
const x=globalThis,k=e=>e,S=x.trustedTypes,E=S?S.createPolicy("lit-html",{createHTML:e=>e}):void 0,T="$lit$",P=`lit$${Math.random().toFixed(9).slice(2)}$`,C="?"+P,M=`<${C}>`,O=document,H=()=>O.createComment(""),U=e=>null===e||"object"!=typeof e&&"function"!=typeof e,N=Array.isArray,z="[ \t\n\f\r]",j=/<(?:(!--|\/[^a-zA-Z])|(\/?[a-zA-Z][^>\s]*)|(\/?$))/g,R=/-->/g,D=/>/g,L=RegExp(`>|${z}(?:([^\\s"'>=/]+)(${z}*=${z}*(?:[^ \t\n\f\r"'\`<>=]|("|')|))|$)`,"g"),I=/'/g,W=/"/g,B=/^(?:script|style|textarea|title)$/i,q=(e=>(t,...s)=>({_$litType$:e,strings:t,values:s}))(1),V=Symbol.for("lit-noChange"),F=Symbol.for("lit-nothing"),J=new WeakMap,G=O.createTreeWalker(O,129);function K(e,t){if(!N(e)||!e.hasOwnProperty("raw"))throw Error("invalid template strings array");return void 0!==E?E.createHTML(t):t}const Z=(e,t)=>{const s=e.length-1,r=[];let o,i=2===t?"<svg>":3===t?"<math>":"",a=j;for(let t=0;t<s;t++){const s=e[t];let n,l,c=-1,d=0;for(;d<s.length&&(a.lastIndex=d,l=a.exec(s),null!==l);)d=a.lastIndex,a===j?"!--"===l[1]?a=R:void 0!==l[1]?a=D:void 0!==l[2]?(B.test(l[2])&&(o=RegExp("</"+l[2],"g")),a=L):void 0!==l[3]&&(a=L):a===L?">"===l[0]?(a=o??j,c=-1):void 0===l[1]?c=-2:(c=a.lastIndex-l[2].length,n=l[1],a=void 0===l[3]?L:'"'===l[3]?W:I):a===W||a===I?a=L:a===R||a===D?a=j:(a=L,o=void 0);const h=a===L&&e[t+1].startsWith("/>")?" ":"";i+=a===j?s+M:c>=0?(r.push(n),s.slice(0,c)+T+s.slice(c)+P+h):s+P+(-2===c?t:h)}return[K(e,i+(e[s]||"<?>")+(2===t?"</svg>":3===t?"</math>":"")),r]};class Q{constructor({strings:e,_$litType$:t},s){let r;this.parts=[];let o=0,i=0;const a=e.length-1,n=this.parts,[l,c]=Z(e,t);if(this.el=Q.createElement(l,s),G.currentNode=this.el.content,2===t||3===t){const e=this.el.content.firstChild;e.replaceWith(...e.childNodes)}for(;null!==(r=G.nextNode())&&n.length<a;){if(1===r.nodeType){if(r.hasAttributes())for(const e of r.getAttributeNames())if(e.endsWith(T)){const t=c[i++],s=r.getAttribute(e).split(P),a=/([.?@])?(.*)/.exec(t);n.push({type:1,index:o,name:a[2],strings:s,ctor:"."===a[1]?se:"?"===a[1]?re:"@"===a[1]?oe:te}),r.removeAttribute(e)}else e.startsWith(P)&&(n.push({type:6,index:o}),r.removeAttribute(e));if(B.test(r.tagName)){const e=r.textContent.split(P),t=e.length-1;if(t>0){r.textContent=S?S.emptyScript:"";for(let s=0;s<t;s++)r.append(e[s],H()),G.nextNode(),n.push({type:2,index:++o});r.append(e[t],H())}}}else if(8===r.nodeType)if(r.data===C)n.push({type:2,index:o});else{let e=-1;for(;-1!==(e=r.data.indexOf(P,e+1));)n.push({type:7,index:o}),e+=P.length-1}o++}}static createElement(e,t){const s=O.createElement("template");return s.innerHTML=e,s}}function X(e,t,s=e,r){if(t===V)return t;let o=void 0!==r?s._$Co?.[r]:s._$Cl;const i=U(t)?void 0:t._$litDirective$;return o?.constructor!==i&&(o?._$AO?.(!1),void 0===i?o=void 0:(o=new i(e),o._$AT(e,s,r)),void 0!==r?(s._$Co??=[])[r]=o:s._$Cl=o),void 0!==o&&(t=X(e,o._$AS(e,t.values),o,r)),t}class Y{constructor(e,t){this._$AV=[],this._$AN=void 0,this._$AD=e,this._$AM=t}get parentNode(){return this._$AM.parentNode}get _$AU(){return this._$AM._$AU}u(e){const{el:{content:t},parts:s}=this._$AD,r=(e?.creationScope??O).importNode(t,!0);G.currentNode=r;let o=G.nextNode(),i=0,a=0,n=s[0];for(;void 0!==n;){if(i===n.index){let t;2===n.type?t=new ee(o,o.nextSibling,this,e):1===n.type?t=new n.ctor(o,n.name,n.strings,this,e):6===n.type&&(t=new ie(o,this,e)),this._$AV.push(t),n=s[++a]}i!==n?.index&&(o=G.nextNode(),i++)}return G.currentNode=O,r}p(e){let t=0;for(const s of this._$AV)void 0!==s&&(void 0!==s.strings?(s._$AI(e,s,t),t+=s.strings.length-2):s._$AI(e[t])),t++}}class ee{get _$AU(){return this._$AM?._$AU??this._$Cv}constructor(e,t,s,r){this.type=2,this._$AH=F,this._$AN=void 0,this._$AA=e,this._$AB=t,this._$AM=s,this.options=r,this._$Cv=r?.isConnected??!0}get parentNode(){let e=this._$AA.parentNode;const t=this._$AM;return void 0!==t&&11===e?.nodeType&&(e=t.parentNode),e}get startNode(){return this._$AA}get endNode(){return this._$AB}_$AI(e,t=this){e=X(this,e,t),U(e)?e===F||null==e||""===e?(this._$AH!==F&&this._$AR(),this._$AH=F):e!==this._$AH&&e!==V&&this._(e):void 0!==e._$litType$?this.$(e):void 0!==e.nodeType?this.T(e):(e=>N(e)||"function"==typeof e?.[Symbol.iterator])(e)?this.k(e):this._(e)}O(e){return this._$AA.parentNode.insertBefore(e,this._$AB)}T(e){this._$AH!==e&&(this._$AR(),this._$AH=this.O(e))}_(e){this._$AH!==F&&U(this._$AH)?this._$AA.nextSibling.data=e:this.T(O.createTextNode(e)),this._$AH=e}$(e){const{values:t,_$litType$:s}=e,r="number"==typeof s?this._$AC(e):(void 0===s.el&&(s.el=Q.createElement(K(s.h,s.h[0]),this.options)),s);if(this._$AH?._$AD===r)this._$AH.p(t);else{const e=new Y(r,this),s=e.u(this.options);e.p(t),this.T(s),this._$AH=e}}_$AC(e){let t=J.get(e.strings);return void 0===t&&J.set(e.strings,t=new Q(e)),t}k(e){N(this._$AH)||(this._$AH=[],this._$AR());const t=this._$AH;let s,r=0;for(const o of e)r===t.length?t.push(s=new ee(this.O(H()),this.O(H()),this,this.options)):s=t[r],s._$AI(o),r++;r<t.length&&(this._$AR(s&&s._$AB.nextSibling,r),t.length=r)}_$AR(e=this._$AA.nextSibling,t){for(this._$AP?.(!1,!0,t);e!==this._$AB;){const t=k(e).nextSibling;k(e).remove(),e=t}}setConnected(e){void 0===this._$AM&&(this._$Cv=e,this._$AP?.(e))}}class te{get tagName(){return this.element.tagName}get _$AU(){return this._$AM._$AU}constructor(e,t,s,r,o){this.type=1,this._$AH=F,this._$AN=void 0,this.element=e,this.name=t,this._$AM=r,this.options=o,s.length>2||""!==s[0]||""!==s[1]?(this._$AH=Array(s.length-1).fill(new String),this.strings=s):this._$AH=F}_$AI(e,t=this,s,r){const o=this.strings;let i=!1;if(void 0===o)e=X(this,e,t,0),i=!U(e)||e!==this._$AH&&e!==V,i&&(this._$AH=e);else{const r=e;let a,n;for(e=o[0],a=0;a<o.length-1;a++)n=X(this,r[s+a],t,a),n===V&&(n=this._$AH[a]),i||=!U(n)||n!==this._$AH[a],n===F?e=F:e!==F&&(e+=(n??"")+o[a+1]),this._$AH[a]=n}i&&!r&&this.j(e)}j(e){e===F?this.element.removeAttribute(this.name):this.element.setAttribute(this.name,e??"")}}class se extends te{constructor(){super(...arguments),this.type=3}j(e){this.element[this.name]=e===F?void 0:e}}class re extends te{constructor(){super(...arguments),this.type=4}j(e){this.element.toggleAttribute(this.name,!!e&&e!==F)}}class oe extends te{constructor(e,t,s,r,o){super(e,t,s,r,o),this.type=5}_$AI(e,t=this){if((e=X(this,e,t,0)??F)===V)return;const s=this._$AH,r=e===F&&s!==F||e.capture!==s.capture||e.once!==s.once||e.passive!==s.passive,o=e!==F&&(s===F||r);r&&this.element.removeEventListener(this.name,this,s),o&&this.element.addEventListener(this.name,this,e),this._$AH=e}handleEvent(e){"function"==typeof this._$AH?this._$AH.call(this.options?.host??this.element,e):this._$AH.handleEvent(e)}}class ie{constructor(e,t,s){this.element=e,this.type=6,this._$AN=void 0,this._$AM=t,this.options=s}get _$AU(){return this._$AM._$AU}_$AI(e){X(this,e)}}const ae=x.litHtmlPolyfillSupport;ae?.(Q,ee),(x.litHtmlVersions??=[]).push("3.3.3");const ne=globalThis;
/**
     * @license
     * Copyright 2017 Google LLC
     * SPDX-License-Identifier: BSD-3-Clause
     */class le extends A{constructor(){super(...arguments),this.renderOptions={host:this},this._$Do=void 0}createRenderRoot(){const e=super.createRenderRoot();return this.renderOptions.renderBefore??=e.firstChild,e}update(e){const t=this.render();this.hasUpdated||(this.renderOptions.isConnected=this.isConnected),super.update(e),this._$Do=((e,t,s)=>{const r=s?.renderBefore??t;let o=r._$litPart$;if(void 0===o){const e=s?.renderBefore??null;r._$litPart$=o=new ee(t.insertBefore(H(),e),e,void 0,s??{})}return o._$AI(e),o})(t,this.renderRoot,this.renderOptions)}connectedCallback(){super.connectedCallback(),this._$Do?.setConnected(!0)}disconnectedCallback(){super.disconnectedCallback(),this._$Do?.setConnected(!1)}render(){return V}}le._$litElement$=!0,le.finalized=!0,ne.litElementHydrateSupport?.({LitElement:le});const ce=ne.litElementPolyfillSupport;ce?.({LitElement:le}),(ne.litElementVersions??=[]).push("4.2.2");
/**
     * @license
     * Copyright 2017 Google LLC
     * SPDX-License-Identifier: BSD-3-Clause
     */
const de={attribute:!0,type:String,converter:w,reflect:!1,hasChanged:$},he=(e=de,t,s)=>{const{kind:r,metadata:o}=s;let i=globalThis.litPropertyMetadata.get(o);if(void 0===i&&globalThis.litPropertyMetadata.set(o,i=new Map),"setter"===r&&((e=Object.create(e)).wrapped=!0),i.set(s.name,e),"accessor"===r){const{name:r}=s;return{set(s){const o=t.get.call(this);t.set.call(this,s),this.requestUpdate(r,o,e,!0,s)},init(t){return void 0!==t&&this.C(r,void 0,e,t),t}}}if("setter"===r){const{name:r}=s;return function(s){const o=this[r];t.call(this,s),this.requestUpdate(r,o,e,!0,s)}}throw Error("Unsupported decorator location: "+r)};
/**
     * @license
     * Copyright 2017 Google LLC
     * SPDX-License-Identifier: BSD-3-Clause
     */function pe(e){return(t,s)=>"object"==typeof s?he(e,t,s):((e,t,s)=>{const r=t.hasOwnProperty(s);return t.constructor.createProperty(s,e),r?Object.getOwnPropertyDescriptor(t,s):void 0})(e,t,s)}
/**
     * @license
     * Copyright 2017 Google LLC
     * SPDX-License-Identifier: BSD-3-Clause
     */function ue(e){return pe({...e,state:!0,attribute:!1})}const fe=new Map,ge=[1e3,2e3,4e3,8e3,16e3,3e4];function me(e,t={}){const s=t.wsCtor??("undefined"!=typeof WebSocket?WebSocket:void 0),r=t.fetchImpl??("undefined"!=typeof fetch?fetch:void 0);let o=null,i="idle",a=null,n=0,l=null,c=null,d=!1,h=!1;const p=new Set,u=()=>{for(const e of p)try{e(o)}catch(e){"undefined"!=typeof console&&console.warn("[ecoflow] snapshot subscriber threw",e)}},f=e=>{i!==e&&(i=e,u())},g=()=>{null!=l&&(clearTimeout(l),l=null)},m=()=>{null!=c&&(clearTimeout(c),c=null)},v=()=>{if(g(),a){a.onopen=null,a.onmessage=null,a.onerror=null,a.onclose=null;try{a.close()}catch{}a=null}},y=()=>{if(d||!s)return;let t;g(),f("idle"===i?"connecting":"reconnecting");try{t=new s(function(e){let t=e.trim().replace(/\/$/,"");return/^https?:\/\//i.test(t)?t=t.replace(/^http/i,"ws"):/^wss?:\/\//i.test(t)||(t=`ws://${t}`),`${t}/ws`}(e))}catch{return void b()}a=t,t.onopen=()=>{d||a!==t||(n=0,f("open"),(()=>{if(h||!r)return;h=!0;const t=function(e,t){let s=e.trim().replace(/\/$/,"");return/^wss?:\/\//i.test(s)?s=s.replace(/^ws/i,"http"):/^https?:\/\//i.test(s)||(s=`http://${s}`),`${s}${t.startsWith("/")?t:`/${t}`}`}(e,"/api/snapshot");r(t).then(e=>e.ok?e.json():null).then(e=>{!d&&e&&null==o&&(o=e,u())}).catch(()=>{})})())},t.onmessage=e=>{if(!d&&a===t)try{const t=JSON.parse("string"==typeof e.data?e.data:"");t&&"snapshot"===t.type&&t.data&&(o=t.data,u())}catch{}},t.onerror=()=>{},t.onclose=()=>{a===t&&(a=null,d?f("closed"):b())}},b=()=>{if(d)return;f("reconnecting");const e=Math.min(n,ge.length-1);n+=1,l=setTimeout(()=>{l=null,y()},ge[e])},w={getSnapshot:()=>o,connectionState:()=>i,subscribe(t){m(),p.add(t);try{t(o)}catch(e){"undefined"!=typeof console&&console.warn("[ecoflow] snapshot subscriber threw",e)}return 1===p.size&&null==a&&"open"!==i&&"connecting"!==i&&"reconnecting"!==i&&y(),()=>{p.delete(t)&&0===p.size&&(m(),c=setTimeout(()=>{c=null,0===p.size&&(v(),n=0,h=!1,f("idle"),fe.get(e)===w&&fe.delete(e))},5e3))}},_destroy(){d=!0,m(),v(),f("closed"),p.clear(),fe.get(e)===w&&fe.delete(e)}};return w}class ve extends le{constructor(){super(...arguments),this.snapshot=null,this.connState="idle",this._unsubscribe=null,this._stateTimer=null}setConfig(e){if(!e)throw new Error("Invalid config");this.config={host:e.host||"http://homeassistant.local:8787",title:e.title||"EcoFlow Panel",refresh_seconds:e.refresh_seconds??30,type:e.type}}effectiveHost(){return this.config?.host||"http://homeassistant.local:8787"}connectedCallback(){super.connectedCallback();const e=function(e){const t=fe.get(e);if(t)return t;const s=me(e);return fe.set(e,s),s}(this.effectiveHost());this.connState=e.connectionState(),this._unsubscribe=e.subscribe(t=>{this.snapshot=t,this.connState=e.connectionState()})}disconnectedCallback(){super.disconnectedCallback(),this._unsubscribe&&this._unsubscribe(),this._unsubscribe=null,this._stateTimer&&(clearInterval(this._stateTimer),this._stateTimer=null)}getCardSize(){return 6}}t([pe({attribute:!1})],ve.prototype,"config",void 0),t([ue()],ve.prototype,"snapshot",void 0),t([ue()],ve.prototype,"connState",void 0);const ye=n`
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
`,be={};function we(e,t){for(const s of e.split("|"))be[s.trim()]=t}function $e(e){const t=function(e){const t=function(e){return e.split("·")[0].split("(")[0].replace(/\s+/g," ").trim().toLowerCase()}(e);return t?be[t]:void 0}(e);return t?q`<span class="ef-glossary"
    >${e}<span class="ef-tooltip" role="tooltip">${t}</span></span
  >`:e}we("soc|state of charge","State of charge — how full the battery is right now, 0–100%."),we("avg soc","Average state of charge across every online battery pack in the fleet."),we("soh|state of health|avg soh","State of health — measured usable capacity vs the pack’s original design capacity. A wear gauge; 100% = like-new."),we("ocv|open-circuit","Open-circuit voltage — the pack’s resting voltage with no load applied."),we("cell spread|worst cell spread|cell imbalance|cell spread now","Cell-voltage spread — the gap between the highest and lowest cell in a pack. A widening gap is an early sign of imbalance."),we("cell mean","Average voltage across all of the pack’s cells."),we("pack volt","Pack terminal voltage."),we("rep temp","Representative pack temperature reported by the BMS."),we("cell max|cell min","Hottest / coldest individual cell temperature in the pack."),we("cell temperatures","Per-cell temperature sensors inside the pack."),we("cell voltages","Per-cell voltage, each shown with its deviation from the pack mean."),we("mos max|mosfet temperatures|mosfet temps|mosfet","Power-MOSFET temperature — the BMS switching transistors."),we("board","BMS circuit-board temperature."),we("shunt","Current-shunt temperature — the precision resistor the BMS measures pack current across."),we("ptc heater temperatures|ptc heater temps|ptc","PTC heater temperature — keeps the cells warm enough to charge safely in the cold."),we("cycles","Equivalent full charge/discharge cycles the pack has completed — a measure of battery age."),we("lifetime throughput","Total energy ever charged into and discharged out of the pack."),we("capacity","Energy the battery can store, in kWh."),we("balancing|cells balancing","The BMS is equalizing cell voltages — routine housekeeping, no action needed."),we("hottest pack","The warmest pack across the fleet right now."),we("vitals","The pack’s key live readings at a glance."),we("pv|pv in|pv total|photovoltaic","Photovoltaic — solar-panel power."),we("pv high mppt|pv low mppt","Power from one of the DPU’s two solar strings (high- or low-voltage MPPT input)."),we("ac out|ac output","AC power flowing out of the inverter to your loads."),we("ac in","AC power flowing into the inverter — grid or generator charging."),we("ac out freq / v","Inverter AC output frequency (Hz) and voltage."),we("total in / out","Total power into and out of the DPU across every input and output."),we("battery v / a","Internal battery-bus voltage and current."),we("in|out","Power flowing in to / out of the device."),we("input|output","Power flowing into (charging) or out of (discharging) the pack."),we("panel load","Total power the SHP2’s circuits are drawing right now."),we("live contribution|live draw","Power this device is feeding/drawing right now."),we("voltage|current","Live electrical voltage / current at this input."),we("v × a","Voltage × current — instantaneous power, shown as a cross-check on the reported watts."),we("string ω","Effective resistance (volts ÷ amps) at the MPPT string’s operating point."),we("mppt|mppt temp|mppt hv|mppt lv|hv mppt|lv mppt","MPPT — the solar charge controller (Maximum Power Point Tracker). Each DPU has two: a high-voltage and a low-voltage string input."),we("hv channels|lv channels","High-/low-voltage MPPT solar string inputs — one of each per DPU."),we("ghi","Global Horizontal Irradiance — total sunlight energy on a flat surface (W/m²); the raw “how sunny” number the forecast is built from."),we("producing now","Solar power being generated right now."),we("peak today","The highest solar power reached so far today."),we("coefficient|peak response|response coefficient","Learned response coefficient — watts of PV produced per W/m² of sunlight. Captures panel size, orientation, shading and inverter clipping."),we("strongest hour","The hour of day your arrays convert sunlight to power most efficiently — reveals their orientation."),we("observed peak pv","The highest PV output actually recorded at this hour-of-day."),we("soiling","Dust/pollen on the panels cutting output. Detected by comparing clear-sky production to the cleanest day on record."),we("output drop","How far clear-sky solar output has fallen below the clean-panel baseline — the soiling indicator."),we("backup|backup pool","SHP2 backup pool — the combined battery the Smart Home Panel draws on."),we("backup %","Backup-pool state of charge, trended over the last hour."),we("reserve floor|backup reserve|reserve","Reserve floor — the state of charge held back for backup. Loads begin shedding below it."),we("solar reserve","Target state of charge to keep in reserve specifically when running on solar."),we("mid-priority floor","The SoC at which mid-priority circuits are cut to protect the battery."),we("charge power","Power currently flowing into the battery."),we("charge time","Estimated time to fully charge the battery."),we("rated power","The device’s rated maximum power output."),we("ems bat temp","Battery temperature as reported by the SHP2’s energy-management system."),we("hw link","Hardware (wired) link status between the SHP2 and this DPU."),we("load-shed strategy","The SHP2’s automatic plan for dropping circuits as the battery depletes."),we("smart backup mode","The SHP2’s backup-behaviour mode setting."),we("charge schedule","The SHP2’s time-of-use scheduled charging windows."),we("error code|direct errors|shp2 errors","Device-reported error code — 0 means no fault."),we("charging power","Power the EV charger is drawing, over the last 24 hours."),we("sessions today","Charging sessions detected today — a sustained draw above 1 kW."),we("host dpu|dpu battery","The Delta Pro Ultra the EV charger is wired to — that DPU’s AC output equals the charging draw."),we("direct telemetry|direct evse telemetry","Raw data straight from the device over MQTT, rather than inferred."),we("solar next 24 h|solar next 24h","Projected solar production, from the cloud forecast run through your learned array model."),we("forecast load|forecast load 24 h|typical solar / day","Projected household load from the typical-day consumption curve."),we("forecast pv","Projected PV output for this hour."),we("projected low soc","The lowest the battery is forecast to reach over the next 24 hours."),we("cloud cover","Forecast cloud cover — what derates the solar prediction each hour."),we("outlook","At-a-glance battery comfort vs the reserve floor: Comfortable, Watch or Tight."),we("history depth","Days of recorded data behind the forecast and learned models — they sharpen as it grows."),we("confidence","How trustworthy the learned model is, based on how many samples it has."),we("z-score|peer z-score","Modified z-score — how many robust deviations a reading sits from normal. Higher = more anomalous; ≥ 3.5 flags, ≥ 5 warns."),we("fit quality|fit r²","R-squared — how well the trend line fits the data, 0–1. Higher means a more trustworthy projection."),we("samples|regression samples","How many data points the estimate is built from — more points, more reliable."),we("sibling median","The median reading across the pack’s four siblings — the “normal” this pack is compared against."),we("this pack","This pack’s current reading."),we("deviation","How far this reading sits from the expected/normal value."),we("baseline window","The span of history and number of samples behind the self-baseline."),we("decline rate|rise rate","How fast the value is changing, per unit time."),we("end-of-life|eol|projected eol|reaches 80%","End of life — the 80%-SoH point where a pack has lost a fifth of its original capacity; the conventional LFP replacement mark."),we("fade rate|fade / yr|avg fade rate","How fast measured capacity (State of Health) is falling — SoH percentage points lost per year."),we("service left|years left|years to eol","Projected years of service remaining before the pack reaches the 80% end-of-life threshold."),we("eol threshold","The State of Health at which a pack counts as end-of-life — conventionally 80% for LFP cells."),we("packs projecting","How many packs have a firm enough SoH trend to project an end-of-life date."),we("soonest eol","The pack across the fleet projected to reach end-of-life first."),we("cycles at eol","Projected equivalent full-cycle count by the time the pack reaches end-of-life."),we("data span","Days of recorded history the projection is regressed over."),we("projection notes","Plain-language end-of-life verdict for each pack with a firm fade trend."),we("trend","Whether a pack has a projected fade trend, is stable, is still learning, or has no data yet."),we("critical","Critical — an immediate problem that needs attention now."),we("warnings|warning","Warning — something to investigate soon."),we("informational|info","Informational — noted for awareness, not urgent."),we("anomalies","Things unusual right now — flagged by peer comparison and self-baseline."),we("forecasts","Where things are heading — runtime, degradation and day-ahead projections."),we("actionable","Critical + warning items that may need attention."),we("recently cleared","Alerts that were raised and have since resolved, with how long each lasted."),we("today","Energy totals since local midnight."),we("solar produced","Total solar energy harvested today."),we("batteries","Net battery energy today — negative means net charged, positive means net discharged.");const _e=e=>{if(!e)return"never";const t=Math.floor((Date.now()-e)/1e3);return t<60?`${t}s ago`:t<3600?`${Math.floor(t/60)}m ago`:`${Math.floor(t/3600)}h ago`};class Ae extends le{constructor(){super(...arguments),this.tone="neutral"}render(){return q`<slot></slot>`}}Ae.styles=[ye,n`
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
    `],t([pe({reflect:!0})],Ae.prototype,"tone",void 0),customElements.get("ef-badge")||customElements.define("ef-badge",Ae);class xe extends le{constructor(){super(...arguments),this.label="",this.value="",this.unit=""}render(){return q`
      <div class="label"><slot name="label">${this.label}</slot></div>
      <div class="value-line">
        <span class="value"><slot name="value">${this.value}</slot></span>
        ${this.unit?q`<span class="unit">${this.unit}</span>`:null}
      </div>
      <slot></slot>
    `}}xe.styles=[ye,n`
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
    `],t([pe()],xe.prototype,"label",void 0),t([pe()],xe.prototype,"value",void 0),t([pe()],xe.prototype,"unit",void 0),customElements.get("ef-tile")||customElements.define("ef-tile",xe);class ke extends le{constructor(){super(...arguments),this.title=""}render(){return q`
      <header>
        <div class="title"><slot name="title">${this.title}</slot></div>
        <div class="header-extra"><slot name="header"></slot></div>
      </header>
      <div class="body"><slot></slot></div>
    `}}function Se(e,t){if(!e.has(t))return e;const s=new Map(e);return s.delete(t),s}return ke.styles=[ye,n`
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
    `],t([pe()],ke.prototype,"title",void 0),customElements.get("ef-section")||customElements.define("ef-section",ke),e.EcoflowAlertsCard=class extends ve{constructor(){super(...arguments),this.cleared=[],this.clearedExpanded=!1,this.clearedLoading=!1,this.clearedError=null,this.notifyStatus=null,this.notifyTestState="idle",this.notifyTestMsg="",this.submittedOutcomes=new Map,this.busyOutcomes=new Map,this.outcomeErrors=new Map}connectedCallback(){super.connectedCallback(),this.loadNotifyStatus()}activeAlerts(){return this.snapshot?.alerts??[]}thresholdAlerts(){return this.activeAlerts().filter(e=>!this.isInsight(e)&&!this.submittedOutcomes.has(e.id))}insightAlerts(){return this.activeAlerts().filter(e=>this.isInsight(e)&&!this.submittedOutcomes.has(e.id))}isInsight(e){return"learned"===e.source||e.id.startsWith("forecast-")}async submitOutcome(e,t){this.submittedOutcomes=new Map(this.submittedOutcomes).set(e,t),this.busyOutcomes=new Map(this.busyOutcomes).set(e,t),this.outcomeErrors=Se(this.outcomeErrors,e);try{const s=this.apiUrl("/api/alerts/outcome"),r=await fetch(s,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({alertId:e,outcome:t})});if(!r.ok){const e=await r.json().catch(()=>null);throw new Error(e?.error??`HTTP ${r.status}`)}}catch(t){this.submittedOutcomes=Se(this.submittedOutcomes,e);const s=t instanceof Error?t.message:String(t);this.outcomeErrors=new Map(this.outcomeErrors).set(e,s),window.setTimeout(()=>{this.outcomeErrors=Se(this.outcomeErrors,e)},4e3)}finally{this.busyOutcomes=Se(this.busyOutcomes,e)}}async toggleCleared(){this.clearedExpanded=!this.clearedExpanded,this.clearedExpanded&&0===this.cleared.length&&!this.clearedLoading&&await this.loadCleared()}async loadCleared(){this.clearedLoading=!0,this.clearedError=null;try{const e=this.apiUrl("/api/alerts/history?limit=20"),t=await fetch(e);if(!t.ok)throw new Error(`HTTP ${t.status}`);const s=await t.json();this.cleared=(s.cleared??[]).slice(0,20)}catch(e){this.clearedError=e instanceof Error?e.message:String(e)}finally{this.clearedLoading=!1}}async loadNotifyStatus(){try{const e=this.apiUrl("/api/notify/status"),t=await fetch(e);t.ok&&(this.notifyStatus=await t.json())}catch{}}async sendNotifyTest(){this.notifyTestState="sending",this.notifyTestMsg="";try{const e=this.apiUrl("/api/notify/test"),t=await fetch(e,{method:"POST"}),s=await t.json().catch(()=>null);t.ok&&s?.ok?(this.notifyTestState="ok",this.notifyTestMsg="Test sent"):(this.notifyTestState="fail",this.notifyTestMsg=s?.error??`HTTP ${t.status}`)}catch(e){this.notifyTestState="fail",this.notifyTestMsg=e instanceof Error?e.message:String(e)}window.setTimeout(()=>{this.notifyTestState="idle",this.notifyTestMsg=""},5e3)}apiUrl(e){return`${this.effectiveHost().replace(/\/$/,"")}${e.startsWith("/")?e:`/${e}`}`}renderAlertRow(e){const t=e.severity,s=this.submittedOutcomes.get(e.id),r=this.busyOutcomes.get(e.id),o=this.outcomeErrors.get(e.id);return q`
      <div class="alert-row" data-sev=${t}>
        <span class="sev-dot" data-sev=${t} aria-hidden="true"></span>
        <div class="alert-body">
          <div class="alert-title-row">
            <span class="alert-title">${e.title}</span>
            <span class="alert-meta">${e.category}</span>
            ${null==e.coreNum?q`<span class="alert-meta">${e.device}</span>`:q`<span class="alert-meta">Core ${e.coreNum}${null!=e.packNum?` / Pack ${e.packNum}`:""}</span>`}
            ${"learned"===e.source?q`<ef-badge tone="info">learned</ef-badge>`:F}
          </div>
          <div class="alert-detail">${e.detail}</div>
          ${e.facts&&e.facts.length>0?q`<div>
                ${e.facts.map(e=>q`<span class="insight-fact" title=${e.label}>${e.label}: ${e.value}</span>`)}
              </div>`:F}
          <div class="outcome-row">
            ${s?q`<span class="submitted-label" data-outcome=${s}
                  >${i=s,"ack"===i?"✓ Acknowledged":"dismiss"===i?"✕ Dismissed (false alarm)":"🔧 Logged as real failure"}</span
                >`:q`
                  <button
                    class="outcome"
                    data-color="ok"
                    title="Acknowledge — real alert, dealing with it"
                    ?disabled=${null!=r}
                    @click=${()=>this.submitOutcome(e.id,"ack")}
                  >
                    ${"ack"===r?"…":$e("Ack")}
                  </button>
                  <button
                    class="outcome"
                    title="Dismiss as false alarm"
                    ?disabled=${null!=r}
                    @click=${()=>this.submitOutcome(e.id,"dismiss")}
                  >
                    ${"dismiss"===r?"…":$e("Dismiss")}
                  </button>
                  <button
                    class="outcome"
                    data-color="bad"
                    title="Preceded an actual hardware failure"
                    ?disabled=${null!=r}
                    @click=${()=>this.submitOutcome(e.id,"failed")}
                  >
                    ${"failed"===r?"…":$e("Failed")}
                  </button>
                `}
            ${o?q`<span class="outcome-error">${o}</span>`:F}
          </div>
        </div>
      </div>
    `;var i}renderActiveSection(){const e=this.thresholdAlerts(),t=function(e){return{critical:e.filter(e=>"critical"===e.severity).length,warning:e.filter(e=>"warning"===e.severity).length,info:e.filter(e=>"info"===e.severity).length}}(this.activeAlerts()),s=`Active (${e.length})`;return 0===e.length?q`
        <ef-section .title=${s}>
          <ef-badge slot="header" tone="ok">all clear</ef-badge>
          <div class="empty-ok">
            <span aria-hidden="true">✓</span>
            No active alerts
          </div>
        </ef-section>
      `:q`
      <ef-section .title=${s}>
        <div slot="header" class="count-row">
          ${t.critical>0?q`<ef-badge tone="bad">${$e("critical")} ${t.critical}</ef-badge>`:F}
          ${t.warning>0?q`<ef-badge tone="warn">${$e("warning")} ${t.warning}</ef-badge>`:F}
          ${t.info>0?q`<ef-badge tone="info">${$e("info")} ${t.info}</ef-badge>`:F}
        </div>
        <div class="alerts-list">
          ${e.map(e=>this.renderAlertRow(e))}
        </div>
      </ef-section>
    `}renderClearedSection(){const e=this.cleared.length;return q`
      <ef-section title="Cleared today">
        <button
          slot="header"
          class="show-btn"
          @click=${()=>{this.toggleCleared()}}
          aria-expanded=${this.clearedExpanded?"true":"false"}
        >
          ${this.clearedExpanded?"Hide":e>0?`Show (${e})`:"Show"}
        </button>
        ${this.clearedExpanded?this.clearedLoading?q`<div class="cleared-meta">Loading…</div>`:this.clearedError?q`<div class="cleared-meta" style="color:var(--ef-bad)">
                  Failed to load: ${this.clearedError}
                </div>`:0===e?q`<div class="cleared-meta">${$e("recently cleared")} — none yet.</div>`:q`<div class="alerts-list">
                    ${this.cleared.map(e=>this.renderClearedRow(e))}
                  </div>`:F}
      </ef-section>
    `}renderClearedRow(e){const t=e.alert;return q`
      <div class="alert-row" data-sev=${t.severity}>
        <span class="sev-dot" data-sev=${t.severity} aria-hidden="true"></span>
        <div class="alert-body">
          <div class="alert-title-row">
            <span class="alert-title">${t.title}</span>
            <ef-badge tone="ok">cleared</ef-badge>
            <span class="alert-meta">${t.category}</span>
          </div>
          <div class="alert-detail">${t.detail}</div>
          <div class="cleared-meta">
            raised ${_e(e.raisedAt)} · cleared ${_e(e.clearedAt)} · lasted
            ${(e=>{if(null==e)return"—";if(e<60)return`${Math.round(e)} min`;const t=Math.floor(e/60),s=Math.round(e%60);return t<24?`${t}h ${s}m`:`${Math.floor(t/24)}d ${t%24}h`})(e.durationMs/6e4)}
          </div>
        </div>
      </div>
    `}renderInsightsSection(){const e=this.insightAlerts();return 0===e.length?F:q`
      <ef-section>
        <span slot="title">${$e("Predictive insights")}</span>
        <ef-badge slot="header" tone="info">${e.length}</ef-badge>
        <div class="alerts-list">
          ${e.map(e=>this.renderAlertRow(e))}
        </div>
      </ef-section>
    `}renderNotifySection(){const e=this.notifyStatus;if(!e)return F;if("none"===e.channel)return q`
        <ef-section title="Notifications">
          <div class="notify-row">
            <ef-badge tone="neutral">disabled</ef-badge>
            <span class="notify-status">Set NOTIFY_CHANNEL in server/.env to enable.</span>
          </div>
        </ef-section>
      `;const t=e.configured;return q`
      <ef-section title="Notifications">
        <div class="notify-row">
          <ef-badge tone=${t?"ok":"warn"}>
            ${e.channel}${t?" · ready":" · not configured"}
          </ef-badge>
          <span class="notify-status"
            >Min sev: ${e.minSeverity}; sent ${e.sentSinceStart} this session</span
          >
          <button
            class="show-btn"
            ?disabled=${"sending"===this.notifyTestState||!t}
            @click=${()=>{this.sendNotifyTest()}}
          >
            ${"sending"===this.notifyTestState?"Sending…":"Test"}
          </button>
          ${this.notifyTestMsg?q`<span class="test-msg" data-state=${this.notifyTestState}
                >${this.notifyTestMsg}</span
              >`:F}
        </div>
      </ef-section>
    `}render(){const e=this.config?.title??"EcoFlow Alerts",t=this.connTone();return q`
      <ha-card>
        <div class="header">
          <span class="title">${e}</span>
          <ef-badge tone=${t}>${this.connState}</ef-badge>
        </div>
        ${this.renderActiveSection()}
        ${this.renderInsightsSection()}
        ${this.renderClearedSection()}
        ${this.renderNotifySection()}
      </ha-card>
    `}connTone(){switch(this.connState){case"open":return"ok";case"connecting":case"reconnecting":return"warn";case"closed":return"bad";default:return"neutral"}}getCardSize(){const e=this.activeAlerts().length;return Math.min(12,3+Math.ceil(.7*e))}},e.EcoflowAlertsCard.styles=[ye,n`
      :host {
        display: block;
      }
      ha-card {
        padding: 12px;
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }
      .title {
        font-weight: 600;
        font-size: 1rem;
        color: var(--ef-ink);
      }
      .count-row {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      .alerts-list {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .alert-row {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: 8px;
        padding: 8px 10px;
        border: 1px solid var(--ef-line);
        border-radius: 8px;
        background: color-mix(in srgb, var(--ef-panel) 92%, transparent);
      }
      .alert-row[data-sev='critical'] {
        border-color: color-mix(in srgb, var(--ef-bad) 45%, var(--ef-line));
        background: color-mix(in srgb, var(--ef-bad) 6%, var(--ef-panel));
      }
      .alert-row[data-sev='warning'] {
        border-color: color-mix(in srgb, var(--ef-warn) 45%, var(--ef-line));
        background: color-mix(in srgb, var(--ef-warn) 5%, var(--ef-panel));
      }
      .alert-row[data-sev='info'] {
        border-color: var(--ef-line);
      }
      .sev-dot {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        margin-top: 6px;
        align-self: flex-start;
        background: var(--ef-muted);
      }
      .sev-dot[data-sev='critical'] {
        background: var(--ef-bad);
      }
      .sev-dot[data-sev='warning'] {
        background: var(--ef-warn);
      }
      .sev-dot[data-sev='info'] {
        background: var(--ef-info);
      }
      .alert-body {
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 3px;
      }
      .alert-title-row {
        display: flex;
        align-items: baseline;
        gap: 6px;
        flex-wrap: wrap;
      }
      .alert-title {
        font-size: 0.85rem;
        font-weight: 600;
        color: var(--ef-ink);
      }
      .alert-meta {
        font-size: 0.7rem;
        color: var(--ef-muted);
      }
      .alert-detail {
        font-size: 0.78rem;
        color: var(--ef-muted);
        line-height: 1.35;
      }
      .outcome-row {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        margin-top: 4px;
        align-items: center;
      }
      button.outcome {
        font: inherit;
        font-size: 0.7rem;
        font-weight: 600;
        padding: 3px 8px;
        border-radius: 6px;
        border: 1px solid var(--ef-line);
        background: var(--ef-panel);
        color: var(--ef-ink);
        cursor: pointer;
        line-height: 1.2;
      }
      button.outcome:hover:not(:disabled) {
        border-color: color-mix(in srgb, var(--ef-accent) 50%, var(--ef-line));
      }
      button.outcome:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      button.outcome[data-color='ok'] {
        border-color: color-mix(in srgb, var(--ef-ok) 45%, var(--ef-line));
        color: var(--ef-ok);
      }
      button.outcome[data-color='bad'] {
        border-color: color-mix(in srgb, var(--ef-bad) 45%, var(--ef-line));
        color: var(--ef-bad);
      }
      .submitted-label {
        font-size: 0.72rem;
        font-weight: 600;
        color: var(--ef-muted);
      }
      .submitted-label[data-outcome='ack'] {
        color: var(--ef-ok);
      }
      .submitted-label[data-outcome='failed'] {
        color: var(--ef-bad);
      }
      .outcome-error {
        font-size: 0.7rem;
        color: var(--ef-bad);
      }
      .empty-ok {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 0.85rem;
        color: var(--ef-ok);
      }
      .show-btn {
        font: inherit;
        font-size: 0.75rem;
        background: transparent;
        border: 1px solid var(--ef-line);
        border-radius: 6px;
        padding: 2px 8px;
        color: var(--ef-accent);
        cursor: pointer;
      }
      .show-btn:hover {
        background: color-mix(in srgb, var(--ef-accent) 8%, transparent);
      }
      .cleared-meta {
        font-size: 0.7rem;
        color: var(--ef-muted);
      }
      .insight-fact {
        display: inline-block;
        font-size: 0.7rem;
        font-family: ui-monospace, monospace;
        background: color-mix(in srgb, var(--ef-line) 50%, transparent);
        border-radius: 4px;
        padding: 1px 6px;
        margin-right: 4px;
        color: var(--ef-ink);
      }
      .notify-row {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
        font-size: 0.8rem;
        color: var(--ef-ink);
      }
      .notify-status {
        color: var(--ef-muted);
      }
      .test-msg {
        font-size: 0.75rem;
      }
      .test-msg[data-state='ok'] {
        color: var(--ef-ok);
      }
      .test-msg[data-state='fail'] {
        color: var(--ef-bad);
      }
    `],t([ue()],e.EcoflowAlertsCard.prototype,"cleared",void 0),t([ue()],e.EcoflowAlertsCard.prototype,"clearedExpanded",void 0),t([ue()],e.EcoflowAlertsCard.prototype,"clearedLoading",void 0),t([ue()],e.EcoflowAlertsCard.prototype,"clearedError",void 0),t([ue()],e.EcoflowAlertsCard.prototype,"notifyStatus",void 0),t([ue()],e.EcoflowAlertsCard.prototype,"notifyTestState",void 0),t([ue()],e.EcoflowAlertsCard.prototype,"notifyTestMsg",void 0),t([ue()],e.EcoflowAlertsCard.prototype,"submittedOutcomes",void 0),t([ue()],e.EcoflowAlertsCard.prototype,"busyOutcomes",void 0),t([ue()],e.EcoflowAlertsCard.prototype,"outcomeErrors",void 0),e.EcoflowAlertsCard=t([(e=>(t,s)=>{void 0!==s?s.addInitializer(()=>{customElements.define(e,t)}):customElements.define(e,t)})("ecoflow-alerts-card")],e.EcoflowAlertsCard),window.customCards=window.customCards||[],window.customCards.push({type:"ecoflow-alerts-card",name:"EcoFlow Alerts Card",description:"Active + cleared alerts, predictive insights and notification controls"}),e}({});
//# sourceMappingURL=ecoflow-alerts-card.js.map
