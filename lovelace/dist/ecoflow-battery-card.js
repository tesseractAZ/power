var EcoflowBatteryCard=function(e){"use strict";function t(e,t,r,s){var o,a=arguments.length,i=a<3?t:null===s?s=Object.getOwnPropertyDescriptor(t,r):s;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)i=Reflect.decorate(e,t,r,s);else for(var n=e.length-1;n>=0;n--)(o=e[n])&&(i=(a<3?o(i):a>3?o(t,r,i):o(t,r))||i);return a>3&&i&&Object.defineProperty(t,r,i),i}"function"==typeof SuppressedError&&SuppressedError;
/**
     * @license
     * Copyright 2019 Google LLC
     * SPDX-License-Identifier: BSD-3-Clause
     */
const r=globalThis,s=r.ShadowRoot&&(void 0===r.ShadyCSS||r.ShadyCSS.nativeShadow)&&"adoptedStyleSheets"in Document.prototype&&"replace"in CSSStyleSheet.prototype,o=Symbol(),a=new WeakMap;let i=class{constructor(e,t,r){if(this._$cssResult$=!0,r!==o)throw Error("CSSResult is not constructable. Use `unsafeCSS` or `css` instead.");this.cssText=e,this.t=t}get styleSheet(){let e=this.o;const t=this.t;if(s&&void 0===e){const r=void 0!==t&&1===t.length;r&&(e=a.get(t)),void 0===e&&((this.o=e=new CSSStyleSheet).replaceSync(this.cssText),r&&a.set(t,e))}return e}toString(){return this.cssText}};const n=(e,...t)=>{const r=1===e.length?e[0]:t.reduce((t,r,s)=>t+(e=>{if(!0===e._$cssResult$)return e.cssText;if("number"==typeof e)return e;throw Error("Value passed to 'css' function must be a 'css' function result: "+e+". Use 'unsafeCSS' to pass non-literal values, but take care to ensure page security.")})(r)+e[s+1],e[0]);return new i(r,e,o)},l=s?e=>e:e=>e instanceof CSSStyleSheet?(e=>{let t="";for(const r of e.cssRules)t+=r.cssText;return(e=>new i("string"==typeof e?e:e+"",void 0,o))(t)})(e):e,{is:c,defineProperty:d,getOwnPropertyDescriptor:h,getOwnPropertyNames:p,getOwnPropertySymbols:u,getPrototypeOf:f}=Object,g=globalThis,v=g.trustedTypes,m=v?v.emptyScript:"",y=g.reactiveElementPolyfillSupport,b=(e,t)=>e,w={toAttribute(e,t){switch(t){case Boolean:e=e?m:null;break;case Object:case Array:e=null==e?e:JSON.stringify(e)}return e},fromAttribute(e,t){let r=e;switch(t){case Boolean:r=null!==e;break;case Number:r=null===e?null:Number(e);break;case Object:case Array:try{r=JSON.parse(e)}catch(e){r=null}}return r}},$=(e,t)=>!c(e,t),_={attribute:!0,type:String,converter:w,reflect:!1,useDefault:!1,hasChanged:$};
/**
     * @license
     * Copyright 2017 Google LLC
     * SPDX-License-Identifier: BSD-3-Clause
     */Symbol.metadata??=Symbol("metadata"),g.litPropertyMetadata??=new WeakMap;let x=class extends HTMLElement{static addInitializer(e){this._$Ei(),(this.l??=[]).push(e)}static get observedAttributes(){return this.finalize(),this._$Eh&&[...this._$Eh.keys()]}static createProperty(e,t=_){if(t.state&&(t.attribute=!1),this._$Ei(),this.prototype.hasOwnProperty(e)&&((t=Object.create(t)).wrapped=!0),this.elementProperties.set(e,t),!t.noAccessor){const r=Symbol(),s=this.getPropertyDescriptor(e,r,t);void 0!==s&&d(this.prototype,e,s)}}static getPropertyDescriptor(e,t,r){const{get:s,set:o}=h(this.prototype,e)??{get(){return this[t]},set(e){this[t]=e}};return{get:s,set(t){const a=s?.call(this);o?.call(this,t),this.requestUpdate(e,a,r)},configurable:!0,enumerable:!0}}static getPropertyOptions(e){return this.elementProperties.get(e)??_}static _$Ei(){if(this.hasOwnProperty(b("elementProperties")))return;const e=f(this);e.finalize(),void 0!==e.l&&(this.l=[...e.l]),this.elementProperties=new Map(e.elementProperties)}static finalize(){if(this.hasOwnProperty(b("finalized")))return;if(this.finalized=!0,this._$Ei(),this.hasOwnProperty(b("properties"))){const e=this.properties,t=[...p(e),...u(e)];for(const r of t)this.createProperty(r,e[r])}const e=this[Symbol.metadata];if(null!==e){const t=litPropertyMetadata.get(e);if(void 0!==t)for(const[e,r]of t)this.elementProperties.set(e,r)}this._$Eh=new Map;for(const[e,t]of this.elementProperties){const r=this._$Eu(e,t);void 0!==r&&this._$Eh.set(r,e)}this.elementStyles=this.finalizeStyles(this.styles)}static finalizeStyles(e){const t=[];if(Array.isArray(e)){const r=new Set(e.flat(1/0).reverse());for(const e of r)t.unshift(l(e))}else void 0!==e&&t.push(l(e));return t}static _$Eu(e,t){const r=t.attribute;return!1===r?void 0:"string"==typeof r?r:"string"==typeof e?e.toLowerCase():void 0}constructor(){super(),this._$Ep=void 0,this.isUpdatePending=!1,this.hasUpdated=!1,this._$Em=null,this._$Ev()}_$Ev(){this._$ES=new Promise(e=>this.enableUpdating=e),this._$AL=new Map,this._$E_(),this.requestUpdate(),this.constructor.l?.forEach(e=>e(this))}addController(e){(this._$EO??=new Set).add(e),void 0!==this.renderRoot&&this.isConnected&&e.hostConnected?.()}removeController(e){this._$EO?.delete(e)}_$E_(){const e=new Map,t=this.constructor.elementProperties;for(const r of t.keys())this.hasOwnProperty(r)&&(e.set(r,this[r]),delete this[r]);e.size>0&&(this._$Ep=e)}createRenderRoot(){const e=this.shadowRoot??this.attachShadow(this.constructor.shadowRootOptions);return((e,t)=>{if(s)e.adoptedStyleSheets=t.map(e=>e instanceof CSSStyleSheet?e:e.styleSheet);else for(const s of t){const t=document.createElement("style"),o=r.litNonce;void 0!==o&&t.setAttribute("nonce",o),t.textContent=s.cssText,e.appendChild(t)}})(e,this.constructor.elementStyles),e}connectedCallback(){this.renderRoot??=this.createRenderRoot(),this.enableUpdating(!0),this._$EO?.forEach(e=>e.hostConnected?.())}enableUpdating(e){}disconnectedCallback(){this._$EO?.forEach(e=>e.hostDisconnected?.())}attributeChangedCallback(e,t,r){this._$AK(e,r)}_$ET(e,t){const r=this.constructor.elementProperties.get(e),s=this.constructor._$Eu(e,r);if(void 0!==s&&!0===r.reflect){const o=(void 0!==r.converter?.toAttribute?r.converter:w).toAttribute(t,r.type);this._$Em=e,null==o?this.removeAttribute(s):this.setAttribute(s,o),this._$Em=null}}_$AK(e,t){const r=this.constructor,s=r._$Eh.get(e);if(void 0!==s&&this._$Em!==s){const e=r.getPropertyOptions(s),o="function"==typeof e.converter?{fromAttribute:e.converter}:void 0!==e.converter?.fromAttribute?e.converter:w;this._$Em=s;const a=o.fromAttribute(t,e.type);this[s]=a??this._$Ej?.get(s)??a,this._$Em=null}}requestUpdate(e,t,r,s=!1,o){if(void 0!==e){const a=this.constructor;if(!1===s&&(o=this[e]),r??=a.getPropertyOptions(e),!((r.hasChanged??$)(o,t)||r.useDefault&&r.reflect&&o===this._$Ej?.get(e)&&!this.hasAttribute(a._$Eu(e,r))))return;this.C(e,t,r)}!1===this.isUpdatePending&&(this._$ES=this._$EP())}C(e,t,{useDefault:r,reflect:s,wrapped:o},a){r&&!(this._$Ej??=new Map).has(e)&&(this._$Ej.set(e,a??t??this[e]),!0!==o||void 0!==a)||(this._$AL.has(e)||(this.hasUpdated||r||(t=void 0),this._$AL.set(e,t)),!0===s&&this._$Em!==e&&(this._$Eq??=new Set).add(e))}async _$EP(){this.isUpdatePending=!0;try{await this._$ES}catch(e){Promise.reject(e)}const e=this.scheduleUpdate();return null!=e&&await e,!this.isUpdatePending}scheduleUpdate(){return this.performUpdate()}performUpdate(){if(!this.isUpdatePending)return;if(!this.hasUpdated){if(this.renderRoot??=this.createRenderRoot(),this._$Ep){for(const[e,t]of this._$Ep)this[e]=t;this._$Ep=void 0}const e=this.constructor.elementProperties;if(e.size>0)for(const[t,r]of e){const{wrapped:e}=r,s=this[t];!0!==e||this._$AL.has(t)||void 0===s||this.C(t,void 0,r,s)}}let e=!1;const t=this._$AL;try{e=this.shouldUpdate(t),e?(this.willUpdate(t),this._$EO?.forEach(e=>e.hostUpdate?.()),this.update(t)):this._$EM()}catch(t){throw e=!1,this._$EM(),t}e&&this._$AE(t)}willUpdate(e){}_$AE(e){this._$EO?.forEach(e=>e.hostUpdated?.()),this.hasUpdated||(this.hasUpdated=!0,this.firstUpdated(e)),this.updated(e)}_$EM(){this._$AL=new Map,this.isUpdatePending=!1}get updateComplete(){return this.getUpdateComplete()}getUpdateComplete(){return this._$ES}shouldUpdate(e){return!0}update(e){this._$Eq&&=this._$Eq.forEach(e=>this._$ET(e,this[e])),this._$EM()}updated(e){}firstUpdated(e){}};x.elementStyles=[],x.shadowRootOptions={mode:"open"},x[b("elementProperties")]=new Map,x[b("finalized")]=new Map,y?.({ReactiveElement:x}),(g.reactiveElementVersions??=[]).push("2.1.2");
/**
     * @license
     * Copyright 2017 Google LLC
     * SPDX-License-Identifier: BSD-3-Clause
     */
const k=globalThis,S=e=>e,A=k.trustedTypes,P=A?A.createPolicy("lit-html",{createHTML:e=>e}):void 0,E="$lit$",C=`lit$${Math.random().toFixed(9).slice(2)}$`,T="?"+C,H=`<${T}>`,M=document,D=()=>M.createComment(""),U=e=>null===e||"object"!=typeof e&&"function"!=typeof e,j=Array.isArray,O="[ \t\n\f\r]",z=/<(?:(!--|\/[^a-zA-Z])|(\/?[a-zA-Z][^>\s]*)|(\/?$))/g,R=/-->/g,N=/>/g,B=RegExp(`>|${O}(?:([^\\s"'>=/]+)(${O}*=${O}*(?:[^ \t\n\f\r"'\`<>=]|("|')|))|$)`,"g"),F=/'/g,L=/"/g,I=/^(?:script|style|textarea|title)$/i,W=(e=>(t,...r)=>({_$litType$:e,strings:t,values:r}))(1),q=Symbol.for("lit-noChange"),V=Symbol.for("lit-nothing"),Y=new WeakMap,J=M.createTreeWalker(M,129);function G(e,t){if(!j(e)||!e.hasOwnProperty("raw"))throw Error("invalid template strings array");return void 0!==P?P.createHTML(t):t}const K=(e,t)=>{const r=e.length-1,s=[];let o,a=2===t?"<svg>":3===t?"<math>":"",i=z;for(let t=0;t<r;t++){const r=e[t];let n,l,c=-1,d=0;for(;d<r.length&&(i.lastIndex=d,l=i.exec(r),null!==l);)d=i.lastIndex,i===z?"!--"===l[1]?i=R:void 0!==l[1]?i=N:void 0!==l[2]?(I.test(l[2])&&(o=RegExp("</"+l[2],"g")),i=B):void 0!==l[3]&&(i=B):i===B?">"===l[0]?(i=o??z,c=-1):void 0===l[1]?c=-2:(c=i.lastIndex-l[2].length,n=l[1],i=void 0===l[3]?B:'"'===l[3]?L:F):i===L||i===F?i=B:i===R||i===N?i=z:(i=B,o=void 0);const h=i===B&&e[t+1].startsWith("/>")?" ":"";a+=i===z?r+H:c>=0?(s.push(n),r.slice(0,c)+E+r.slice(c)+C+h):r+C+(-2===c?t:h)}return[G(e,a+(e[r]||"<?>")+(2===t?"</svg>":3===t?"</math>":"")),s]};class Z{constructor({strings:e,_$litType$:t},r){let s;this.parts=[];let o=0,a=0;const i=e.length-1,n=this.parts,[l,c]=K(e,t);if(this.el=Z.createElement(l,r),J.currentNode=this.el.content,2===t||3===t){const e=this.el.content.firstChild;e.replaceWith(...e.childNodes)}for(;null!==(s=J.nextNode())&&n.length<i;){if(1===s.nodeType){if(s.hasAttributes())for(const e of s.getAttributeNames())if(e.endsWith(E)){const t=c[a++],r=s.getAttribute(e).split(C),i=/([.?@])?(.*)/.exec(t);n.push({type:1,index:o,name:i[2],strings:r,ctor:"."===i[1]?re:"?"===i[1]?se:"@"===i[1]?oe:te}),s.removeAttribute(e)}else e.startsWith(C)&&(n.push({type:6,index:o}),s.removeAttribute(e));if(I.test(s.tagName)){const e=s.textContent.split(C),t=e.length-1;if(t>0){s.textContent=A?A.emptyScript:"";for(let r=0;r<t;r++)s.append(e[r],D()),J.nextNode(),n.push({type:2,index:++o});s.append(e[t],D())}}}else if(8===s.nodeType)if(s.data===T)n.push({type:2,index:o});else{let e=-1;for(;-1!==(e=s.data.indexOf(C,e+1));)n.push({type:7,index:o}),e+=C.length-1}o++}}static createElement(e,t){const r=M.createElement("template");return r.innerHTML=e,r}}function Q(e,t,r=e,s){if(t===q)return t;let o=void 0!==s?r._$Co?.[s]:r._$Cl;const a=U(t)?void 0:t._$litDirective$;return o?.constructor!==a&&(o?._$AO?.(!1),void 0===a?o=void 0:(o=new a(e),o._$AT(e,r,s)),void 0!==s?(r._$Co??=[])[s]=o:r._$Cl=o),void 0!==o&&(t=Q(e,o._$AS(e,t.values),o,s)),t}class X{constructor(e,t){this._$AV=[],this._$AN=void 0,this._$AD=e,this._$AM=t}get parentNode(){return this._$AM.parentNode}get _$AU(){return this._$AM._$AU}u(e){const{el:{content:t},parts:r}=this._$AD,s=(e?.creationScope??M).importNode(t,!0);J.currentNode=s;let o=J.nextNode(),a=0,i=0,n=r[0];for(;void 0!==n;){if(a===n.index){let t;2===n.type?t=new ee(o,o.nextSibling,this,e):1===n.type?t=new n.ctor(o,n.name,n.strings,this,e):6===n.type&&(t=new ae(o,this,e)),this._$AV.push(t),n=r[++i]}a!==n?.index&&(o=J.nextNode(),a++)}return J.currentNode=M,s}p(e){let t=0;for(const r of this._$AV)void 0!==r&&(void 0!==r.strings?(r._$AI(e,r,t),t+=r.strings.length-2):r._$AI(e[t])),t++}}class ee{get _$AU(){return this._$AM?._$AU??this._$Cv}constructor(e,t,r,s){this.type=2,this._$AH=V,this._$AN=void 0,this._$AA=e,this._$AB=t,this._$AM=r,this.options=s,this._$Cv=s?.isConnected??!0}get parentNode(){let e=this._$AA.parentNode;const t=this._$AM;return void 0!==t&&11===e?.nodeType&&(e=t.parentNode),e}get startNode(){return this._$AA}get endNode(){return this._$AB}_$AI(e,t=this){e=Q(this,e,t),U(e)?e===V||null==e||""===e?(this._$AH!==V&&this._$AR(),this._$AH=V):e!==this._$AH&&e!==q&&this._(e):void 0!==e._$litType$?this.$(e):void 0!==e.nodeType?this.T(e):(e=>j(e)||"function"==typeof e?.[Symbol.iterator])(e)?this.k(e):this._(e)}O(e){return this._$AA.parentNode.insertBefore(e,this._$AB)}T(e){this._$AH!==e&&(this._$AR(),this._$AH=this.O(e))}_(e){this._$AH!==V&&U(this._$AH)?this._$AA.nextSibling.data=e:this.T(M.createTextNode(e)),this._$AH=e}$(e){const{values:t,_$litType$:r}=e,s="number"==typeof r?this._$AC(e):(void 0===r.el&&(r.el=Z.createElement(G(r.h,r.h[0]),this.options)),r);if(this._$AH?._$AD===s)this._$AH.p(t);else{const e=new X(s,this),r=e.u(this.options);e.p(t),this.T(r),this._$AH=e}}_$AC(e){let t=Y.get(e.strings);return void 0===t&&Y.set(e.strings,t=new Z(e)),t}k(e){j(this._$AH)||(this._$AH=[],this._$AR());const t=this._$AH;let r,s=0;for(const o of e)s===t.length?t.push(r=new ee(this.O(D()),this.O(D()),this,this.options)):r=t[s],r._$AI(o),s++;s<t.length&&(this._$AR(r&&r._$AB.nextSibling,s),t.length=s)}_$AR(e=this._$AA.nextSibling,t){for(this._$AP?.(!1,!0,t);e!==this._$AB;){const t=S(e).nextSibling;S(e).remove(),e=t}}setConnected(e){void 0===this._$AM&&(this._$Cv=e,this._$AP?.(e))}}class te{get tagName(){return this.element.tagName}get _$AU(){return this._$AM._$AU}constructor(e,t,r,s,o){this.type=1,this._$AH=V,this._$AN=void 0,this.element=e,this.name=t,this._$AM=s,this.options=o,r.length>2||""!==r[0]||""!==r[1]?(this._$AH=Array(r.length-1).fill(new String),this.strings=r):this._$AH=V}_$AI(e,t=this,r,s){const o=this.strings;let a=!1;if(void 0===o)e=Q(this,e,t,0),a=!U(e)||e!==this._$AH&&e!==q,a&&(this._$AH=e);else{const s=e;let i,n;for(e=o[0],i=0;i<o.length-1;i++)n=Q(this,s[r+i],t,i),n===q&&(n=this._$AH[i]),a||=!U(n)||n!==this._$AH[i],n===V?e=V:e!==V&&(e+=(n??"")+o[i+1]),this._$AH[i]=n}a&&!s&&this.j(e)}j(e){e===V?this.element.removeAttribute(this.name):this.element.setAttribute(this.name,e??"")}}class re extends te{constructor(){super(...arguments),this.type=3}j(e){this.element[this.name]=e===V?void 0:e}}class se extends te{constructor(){super(...arguments),this.type=4}j(e){this.element.toggleAttribute(this.name,!!e&&e!==V)}}class oe extends te{constructor(e,t,r,s,o){super(e,t,r,s,o),this.type=5}_$AI(e,t=this){if((e=Q(this,e,t,0)??V)===q)return;const r=this._$AH,s=e===V&&r!==V||e.capture!==r.capture||e.once!==r.once||e.passive!==r.passive,o=e!==V&&(r===V||s);s&&this.element.removeEventListener(this.name,this,r),o&&this.element.addEventListener(this.name,this,e),this._$AH=e}handleEvent(e){"function"==typeof this._$AH?this._$AH.call(this.options?.host??this.element,e):this._$AH.handleEvent(e)}}class ae{constructor(e,t,r){this.element=e,this.type=6,this._$AN=void 0,this._$AM=t,this.options=r}get _$AU(){return this._$AM._$AU}_$AI(e){Q(this,e)}}const ie=k.litHtmlPolyfillSupport;ie?.(Z,ee),(k.litHtmlVersions??=[]).push("3.3.3");const ne=globalThis;
/**
     * @license
     * Copyright 2017 Google LLC
     * SPDX-License-Identifier: BSD-3-Clause
     */class le extends x{constructor(){super(...arguments),this.renderOptions={host:this},this._$Do=void 0}createRenderRoot(){const e=super.createRenderRoot();return this.renderOptions.renderBefore??=e.firstChild,e}update(e){const t=this.render();this.hasUpdated||(this.renderOptions.isConnected=this.isConnected),super.update(e),this._$Do=((e,t,r)=>{const s=r?.renderBefore??t;let o=s._$litPart$;if(void 0===o){const e=r?.renderBefore??null;s._$litPart$=o=new ee(t.insertBefore(D(),e),e,void 0,r??{})}return o._$AI(e),o})(t,this.renderRoot,this.renderOptions)}connectedCallback(){super.connectedCallback(),this._$Do?.setConnected(!0)}disconnectedCallback(){super.disconnectedCallback(),this._$Do?.setConnected(!1)}render(){return q}}le._$litElement$=!0,le.finalized=!0,ne.litElementHydrateSupport?.({LitElement:le});const ce=ne.litElementPolyfillSupport;ce?.({LitElement:le}),(ne.litElementVersions??=[]).push("4.2.2");
/**
     * @license
     * Copyright 2017 Google LLC
     * SPDX-License-Identifier: BSD-3-Clause
     */
const de=e=>(t,r)=>{void 0!==r?r.addInitializer(()=>{customElements.define(e,t)}):customElements.define(e,t)},he={attribute:!0,type:String,converter:w,reflect:!1,hasChanged:$},pe=(e=he,t,r)=>{const{kind:s,metadata:o}=r;let a=globalThis.litPropertyMetadata.get(o);if(void 0===a&&globalThis.litPropertyMetadata.set(o,a=new Map),"setter"===s&&((e=Object.create(e)).wrapped=!0),a.set(r.name,e),"accessor"===s){const{name:s}=r;return{set(r){const o=t.get.call(this);t.set.call(this,r),this.requestUpdate(s,o,e,!0,r)},init(t){return void 0!==t&&this.C(s,void 0,e,t),t}}}if("setter"===s){const{name:s}=r;return function(r){const o=this[s];t.call(this,r),this.requestUpdate(s,o,e,!0,r)}}throw Error("Unsupported decorator location: "+s)};
/**
     * @license
     * Copyright 2017 Google LLC
     * SPDX-License-Identifier: BSD-3-Clause
     */function ue(e){return(t,r)=>"object"==typeof r?pe(e,t,r):((e,t,r)=>{const s=t.hasOwnProperty(r);return t.constructor.createProperty(r,e),s?Object.getOwnPropertyDescriptor(t,r):void 0})(e,t,r)}
/**
     * @license
     * Copyright 2017 Google LLC
     * SPDX-License-Identifier: BSD-3-Clause
     */function fe(e){return ue({...e,state:!0,attribute:!1})}const ge=new Map,ve=[1e3,2e3,4e3,8e3,16e3,3e4];function me(e,t={}){const r=t.wsCtor??("undefined"!=typeof WebSocket?WebSocket:void 0),s=t.fetchImpl??("undefined"!=typeof fetch?fetch:void 0);let o=null,a="idle",i=null,n=0,l=null,c=null,d=!1,h=!1;const p=new Set,u=()=>{for(const e of p)try{e(o)}catch(e){"undefined"!=typeof console&&console.warn("[ecoflow] snapshot subscriber threw",e)}},f=e=>{a!==e&&(a=e,u())},g=()=>{null!=l&&(clearTimeout(l),l=null)},v=()=>{null!=c&&(clearTimeout(c),c=null)},m=()=>{if(g(),i){i.onopen=null,i.onmessage=null,i.onerror=null,i.onclose=null;try{i.close()}catch{}i=null}},y=()=>{if(d||!r)return;let t;g(),f("idle"===a?"connecting":"reconnecting");try{t=new r(function(e){let t=e.trim().replace(/\/$/,"");return/^https?:\/\//i.test(t)?t=t.replace(/^http/i,"ws"):/^wss?:\/\//i.test(t)||(t=`ws://${t}`),`${t}/ws`}(e))}catch{return void b()}i=t,t.onopen=()=>{d||i!==t||(n=0,f("open"),(()=>{if(h||!s)return;h=!0;const t=function(e,t){let r=e.trim().replace(/\/$/,"");return/^wss?:\/\//i.test(r)?r=r.replace(/^ws/i,"http"):/^https?:\/\//i.test(r)||(r=`http://${r}`),`${r}${t.startsWith("/")?t:`/${t}`}`}(e,"/api/snapshot");s(t).then(e=>e.ok?e.json():null).then(e=>{!d&&e&&null==o&&(o=e,u())}).catch(()=>{})})())},t.onmessage=e=>{if(!d&&i===t)try{const t=JSON.parse("string"==typeof e.data?e.data:"");t&&"snapshot"===t.type&&t.data&&(o=t.data,u())}catch{}},t.onerror=()=>{},t.onclose=()=>{i===t&&(i=null,d?f("closed"):b())}},b=()=>{if(d)return;f("reconnecting");const e=Math.min(n,ve.length-1);n+=1,l=setTimeout(()=>{l=null,y()},ve[e])},w={getSnapshot:()=>o,connectionState:()=>a,subscribe(t){v(),p.add(t);try{t(o)}catch(e){"undefined"!=typeof console&&console.warn("[ecoflow] snapshot subscriber threw",e)}return 1===p.size&&null==i&&"open"!==a&&"connecting"!==a&&"reconnecting"!==a&&y(),()=>{p.delete(t)&&0===p.size&&(v(),c=setTimeout(()=>{c=null,0===p.size&&(m(),n=0,h=!1,f("idle"),ge.get(e)===w&&ge.delete(e))},5e3))}},_destroy(){d=!0,v(),m(),f("closed"),p.clear(),ge.get(e)===w&&ge.delete(e)}};return w}class ye extends le{constructor(){super(...arguments),this.snapshot=null,this.connState="idle",this._unsubscribe=null,this._stateTimer=null}setConfig(e){if(!e)throw new Error("Invalid config");this.config={host:e.host||"http://homeassistant.local:8787",title:e.title||"EcoFlow Panel",refresh_seconds:e.refresh_seconds??30,type:e.type}}effectiveHost(){return this.config?.host||"http://homeassistant.local:8787"}connectedCallback(){super.connectedCallback();const e=function(e){const t=ge.get(e);if(t)return t;const r=me(e);return ge.set(e,r),r}(this.effectiveHost());this.connState=e.connectionState(),this._unsubscribe=e.subscribe(t=>{this.snapshot=t,this.connState=e.connectionState()})}disconnectedCallback(){super.disconnectedCallback(),this._unsubscribe&&this._unsubscribe(),this._unsubscribe=null,this._stateTimer&&(clearInterval(this._stateTimer),this._stateTimer=null)}getCardSize(){return 6}}t([ue({attribute:!1})],ye.prototype,"config",void 0),t([fe()],ye.prototype,"snapshot",void 0),t([fe()],ye.prototype,"connState",void 0);const be=n`
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
`,we={};function $e(e,t){for(const r of e.split("|"))we[r.trim()]=t}function _e(e){const t=function(e){const t=function(e){return e.split("·")[0].split("(")[0].replace(/\s+/g," ").trim().toLowerCase()}(e);return t?we[t]:void 0}(e);return t?W`<span class="ef-glossary"
    >${e}<span class="ef-tooltip" role="tooltip">${t}</span></span
  >`:e}function xe(e,t,r,s){const o=t-e||1,a=s-r;return t=>r+(t-e)/o*a}function ke(e,t={}){const r=t.width??320,s=t.height??40,o=t.color??"var(--ef-accent)",a=e.map(e=>e.value).filter(e=>null!=e&&Number.isFinite(e));if(a.length<2)return W`<div style="height:${s}px;color:var(--ef-muted);font-size:10px;">collecting…</div>`;const i=Math.min(...a),n=Math.max(...a),l=.05*(n-i)||1,c=t.yMin??i-l,d=t.yMax??n+l,h=function(e,t,r){const s=[];let o=!1;for(const a of e){if(null==a.value||!Number.isFinite(a.value)){o=!1;continue}const e=t(a.ts),i=r(a.value);s.push(`${o?"L":"M"} ${e.toFixed(1)} ${i.toFixed(1)}`),o=!0}return s.join(" ")}(e,xe(e[0].ts,e[e.length-1].ts,2,r-2),xe(c,d,s-2,2));return W`
    <svg viewBox="0 0 ${r} ${s}" width="100%" height="${s}" preserveAspectRatio="none" aria-hidden="true">
      <path d=${h} fill="none" stroke=${o} stroke-width="1.5" />
    </svg>
  `}$e("soc|state of charge","State of charge — how full the battery is right now, 0–100%."),$e("avg soc","Average state of charge across every online battery pack in the fleet."),$e("soh|state of health|avg soh","State of health — measured usable capacity vs the pack’s original design capacity. A wear gauge; 100% = like-new."),$e("ocv|open-circuit","Open-circuit voltage — the pack’s resting voltage with no load applied."),$e("cell spread|worst cell spread|cell imbalance|cell spread now","Cell-voltage spread — the gap between the highest and lowest cell in a pack. A widening gap is an early sign of imbalance."),$e("cell mean","Average voltage across all of the pack’s cells."),$e("pack volt","Pack terminal voltage."),$e("rep temp","Representative pack temperature reported by the BMS."),$e("cell max|cell min","Hottest / coldest individual cell temperature in the pack."),$e("cell temperatures","Per-cell temperature sensors inside the pack."),$e("cell voltages","Per-cell voltage, each shown with its deviation from the pack mean."),$e("mos max|mosfet temperatures|mosfet temps|mosfet","Power-MOSFET temperature — the BMS switching transistors."),$e("board","BMS circuit-board temperature."),$e("shunt","Current-shunt temperature — the precision resistor the BMS measures pack current across."),$e("ptc heater temperatures|ptc heater temps|ptc","PTC heater temperature — keeps the cells warm enough to charge safely in the cold."),$e("cycles","Equivalent full charge/discharge cycles the pack has completed — a measure of battery age."),$e("lifetime throughput","Total energy ever charged into and discharged out of the pack."),$e("capacity","Energy the battery can store, in kWh."),$e("balancing|cells balancing","The BMS is equalizing cell voltages — routine housekeeping, no action needed."),$e("hottest pack","The warmest pack across the fleet right now."),$e("vitals","The pack’s key live readings at a glance."),$e("pv|pv in|pv total|photovoltaic","Photovoltaic — solar-panel power."),$e("pv high mppt|pv low mppt","Power from one of the DPU’s two solar strings (high- or low-voltage MPPT input)."),$e("ac out|ac output","AC power flowing out of the inverter to your loads."),$e("ac in","AC power flowing into the inverter — grid or generator charging."),$e("ac out freq / v","Inverter AC output frequency (Hz) and voltage."),$e("total in / out","Total power into and out of the DPU across every input and output."),$e("battery v / a","Internal battery-bus voltage and current."),$e("in|out","Power flowing in to / out of the device."),$e("input|output","Power flowing into (charging) or out of (discharging) the pack."),$e("panel load","Total power the SHP2’s circuits are drawing right now."),$e("live contribution|live draw","Power this device is feeding/drawing right now."),$e("voltage|current","Live electrical voltage / current at this input."),$e("v × a","Voltage × current — instantaneous power, shown as a cross-check on the reported watts."),$e("string ω","Effective resistance (volts ÷ amps) at the MPPT string’s operating point."),$e("mppt|mppt temp|mppt hv|mppt lv|hv mppt|lv mppt","MPPT — the solar charge controller (Maximum Power Point Tracker). Each DPU has two: a high-voltage and a low-voltage string input."),$e("hv channels|lv channels","High-/low-voltage MPPT solar string inputs — one of each per DPU."),$e("ghi","Global Horizontal Irradiance — total sunlight energy on a flat surface (W/m²); the raw “how sunny” number the forecast is built from."),$e("producing now","Solar power being generated right now."),$e("peak today","The highest solar power reached so far today."),$e("coefficient|peak response|response coefficient","Learned response coefficient — watts of PV produced per W/m² of sunlight. Captures panel size, orientation, shading and inverter clipping."),$e("strongest hour","The hour of day your arrays convert sunlight to power most efficiently — reveals their orientation."),$e("observed peak pv","The highest PV output actually recorded at this hour-of-day."),$e("soiling","Dust/pollen on the panels cutting output. Detected by comparing clear-sky production to the cleanest day on record."),$e("output drop","How far clear-sky solar output has fallen below the clean-panel baseline — the soiling indicator."),$e("backup|backup pool","SHP2 backup pool — the combined battery the Smart Home Panel draws on."),$e("backup %","Backup-pool state of charge, trended over the last hour."),$e("reserve floor|backup reserve|reserve","Reserve floor — the state of charge held back for backup. Loads begin shedding below it."),$e("solar reserve","Target state of charge to keep in reserve specifically when running on solar."),$e("mid-priority floor","The SoC at which mid-priority circuits are cut to protect the battery."),$e("charge power","Power currently flowing into the battery."),$e("charge time","Estimated time to fully charge the battery."),$e("rated power","The device’s rated maximum power output."),$e("ems bat temp","Battery temperature as reported by the SHP2’s energy-management system."),$e("hw link","Hardware (wired) link status between the SHP2 and this DPU."),$e("load-shed strategy","The SHP2’s automatic plan for dropping circuits as the battery depletes."),$e("smart backup mode","The SHP2’s backup-behaviour mode setting."),$e("charge schedule","The SHP2’s time-of-use scheduled charging windows."),$e("error code|direct errors|shp2 errors","Device-reported error code — 0 means no fault."),$e("charging power","Power the EV charger is drawing, over the last 24 hours."),$e("sessions today","Charging sessions detected today — a sustained draw above 1 kW."),$e("host dpu|dpu battery","The Delta Pro Ultra the EV charger is wired to — that DPU’s AC output equals the charging draw."),$e("direct telemetry|direct evse telemetry","Raw data straight from the device over MQTT, rather than inferred."),$e("solar next 24 h|solar next 24h","Projected solar production, from the cloud forecast run through your learned array model."),$e("forecast load|forecast load 24 h|typical solar / day","Projected household load from the typical-day consumption curve."),$e("forecast pv","Projected PV output for this hour."),$e("projected low soc","The lowest the battery is forecast to reach over the next 24 hours."),$e("cloud cover","Forecast cloud cover — what derates the solar prediction each hour."),$e("outlook","At-a-glance battery comfort vs the reserve floor: Comfortable, Watch or Tight."),$e("history depth","Days of recorded data behind the forecast and learned models — they sharpen as it grows."),$e("confidence","How trustworthy the learned model is, based on how many samples it has."),$e("z-score|peer z-score","Modified z-score — how many robust deviations a reading sits from normal. Higher = more anomalous; ≥ 3.5 flags, ≥ 5 warns."),$e("fit quality|fit r²","R-squared — how well the trend line fits the data, 0–1. Higher means a more trustworthy projection."),$e("samples|regression samples","How many data points the estimate is built from — more points, more reliable."),$e("sibling median","The median reading across the pack’s four siblings — the “normal” this pack is compared against."),$e("this pack","This pack’s current reading."),$e("deviation","How far this reading sits from the expected/normal value."),$e("baseline window","The span of history and number of samples behind the self-baseline."),$e("decline rate|rise rate","How fast the value is changing, per unit time."),$e("end-of-life|eol|projected eol|reaches 80%","End of life — the 80%-SoH point where a pack has lost a fifth of its original capacity; the conventional LFP replacement mark."),$e("fade rate|fade / yr|avg fade rate","How fast measured capacity (State of Health) is falling — SoH percentage points lost per year."),$e("service left|years left|years to eol","Projected years of service remaining before the pack reaches the 80% end-of-life threshold."),$e("eol threshold","The State of Health at which a pack counts as end-of-life — conventionally 80% for LFP cells."),$e("packs projecting","How many packs have a firm enough SoH trend to project an end-of-life date."),$e("soonest eol","The pack across the fleet projected to reach end-of-life first."),$e("cycles at eol","Projected equivalent full-cycle count by the time the pack reaches end-of-life."),$e("data span","Days of recorded history the projection is regressed over."),$e("projection notes","Plain-language end-of-life verdict for each pack with a firm fade trend."),$e("trend","Whether a pack has a projected fade trend, is stable, is still learning, or has no data yet."),$e("critical","Critical — an immediate problem that needs attention now."),$e("warnings|warning","Warning — something to investigate soon."),$e("informational|info","Informational — noted for awareness, not urgent."),$e("anomalies","Things unusual right now — flagged by peer comparison and self-baseline."),$e("forecasts","Where things are heading — runtime, degradation and day-ahead projections."),$e("actionable","Critical + warning items that may need attention."),$e("recently cleared","Alerts that were raised and have since resolved, with how long each lasted."),$e("today","Energy totals since local midnight."),$e("solar produced","Total solar energy harvested today."),$e("batteries","Net battery energy today — negative means net charged, positive means net discharged.");const Se=(e,t=0)=>null==e?"—":`${e.toFixed(t)}%`,Ae=e=>9*e/5+32;let Pe=class extends le{constructor(){super(...arguments),this.tone="neutral"}render(){return W`<slot></slot>`}};Pe.styles=[be,n`
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
    `],t([ue({reflect:!0})],Pe.prototype,"tone",void 0),Pe=t([de("ef-badge")],Pe);let Ee=class extends le{constructor(){super(...arguments),this.label="",this.value="",this.unit=""}render(){return W`
      <div class="label"><slot name="label">${this.label}</slot></div>
      <div class="value-line">
        <span class="value"><slot name="value">${this.value}</slot></span>
        ${this.unit?W`<span class="unit">${this.unit}</span>`:null}
      </div>
      <slot></slot>
    `}};Ee.styles=[be,n`
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
    `],t([ue()],Ee.prototype,"label",void 0),t([ue()],Ee.prototype,"value",void 0),t([ue()],Ee.prototype,"unit",void 0),Ee=t([de("ef-tile")],Ee);let Ce=class extends le{constructor(){super(...arguments),this.title=""}render(){return W`
      <header>
        <div class="title"><slot name="title">${this.title}</slot></div>
        <div class="header-extra"><slot name="header"></slot></div>
      </header>
      <div class="body"><slot></slot></div>
    `}};Ce.styles=[be,n`
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
    `],t([ue()],Ce.prototype,"title",void 0),Ce=t([de("ef-section")],Ce);return e.EcoflowBatteryCard=class extends ye{constructor(){super(...arguments),this.deg={data:null,stale:!1},this.rte={data:null,stale:!1},this._httpTimer=null}connectedCallback(){super.connectedCallback(),this._kickHttpFetches();const e=Math.max(10,this.config?.refresh_seconds??30);this._httpTimer=setInterval(()=>this._kickHttpFetches(),1e3*e)}disconnectedCallback(){super.disconnectedCallback(),this._httpTimer&&(clearInterval(this._httpTimer),this._httpTimer=null)}_kickHttpFetches(){this._fetchOne("/api/degradation",()=>this.deg,e=>this.deg=e),this._fetchOne("/api/round-trip-efficiency",()=>this.rte,e=>this.rte=e)}async _fetchOne(e,t,r){try{const t=this.effectiveHost().replace(/\/$/,"")+e,s=await fetch(t);if(!s.ok)throw new Error(`HTTP ${s.status}`);r({data:await s.json(),stale:!1})}catch{r({...t(),stale:!0})}}connTone(e){return"open"===e?"ok":"connecting"===e||"reconnecting"===e?"warn":"closed"===e?"bad":"neutral"}connLabel(e){return"open"===e?"live":"connecting"===e?"linking":"reconnecting"===e?"reconnecting":"closed"===e?"offline":"idle"}packTone(e){const t=e.maxCellTemp??e.temp,r=e.maxVolDiffMv,s=e.actSoh??e.soh;let o="ok";const a=e=>{const t={neutral:0,ok:1,warn:2,bad:3};t[e]>t[o]&&(o=e)};if(null!=t){const e=Ae(t);e>=113?a("bad"):e>=95&&a("warn")}return null!=r&&(r>100?a("bad"):r>50&&a("warn")),null!=s&&(s<70?a("bad"):s<80&&a("warn")),o}badgeTone(e){return e}tempClass(e){if(null==e)return"";const t=Ae(e);return t>=113?"bad":t>=95?"warn":""}spreadClass(e){return null==e?"":e>100?"bad":e>50?"warn":""}sohClass(e){return null==e?"":e<70?"bad":e<80?"warn":""}synthSohTrend(e){if(null==e.currentSoh)return[];const t=(e.fadePctPerYear??0)/365,r=Date.now(),s=[];for(let o=90;o>=0;o--){const a=r-864e5*o,i=e.currentSoh+o*t;s.push({ts:a,value:i})}return s}render(){const e=this.snapshot,t=this.config?.title??"Battery";if(!e)return W`<ha-card>
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
      </ha-card>`;const r=Object.values(e.devices).filter(e=>e.productName.toLowerCase().includes("delta pro ultra"));return W`<ha-card>
      ${this.renderHeader(t,r)}
      ${this.renderFleetRollup(r)}
      ${this.renderPerPackThermal(r)}
      ${this.renderDegradation(r)}
      ${this.renderRoundTripEfficiency()}
    </ha-card>`}renderHeader(e,t){const r=t.reduce((e,t)=>e+(t.projection?.packs.length??0),0);return W`<div class="header">
      <div>
        <div class="title">${e}</div>
        <div class="subtitle">${t.length} DPU · ${r} packs</div>
      </div>
      <div class="badges">
        <ef-badge tone=${this.connTone(this.connState)}>${this.connLabel(this.connState)}</ef-badge>
      </div>
    </div>`}renderFleetRollup(e){let t=0,r=0,s=0,o=0;for(const a of e)if(a.online&&a.projection)for(const e of a.projection.packs){t++,null!=e.soc&&(r+=e.soc);const a=e.actSoh??e.soh;null!=a&&(s+=a),null!=e.fullCapMah&&(o+=e.fullCapMah)}const a=t?r/t:null,i=t?s/t:null,n=.1024*o/1e3,l=null!=a&&n>0?a/100*n:null;return W`<ef-section .title=${"Fleet"}>
      <div class="rollup-row">
        <ef-tile
          label="Stored"
          value=${null!=l?l.toFixed(1):"—"}
          unit=${null!=l?"kWh":""}
        ></ef-tile>
        <ef-tile label="Avg SoC" value=${null!=a?a.toFixed(0):"—"} unit=${null!=a?"%":""}>
          <span slot="label">${_e("avg soc")}</span>
        </ef-tile>
        <ef-tile label="Avg SoH" value=${null!=i?i.toFixed(1):"—"} unit=${null!=i?"%":""}>
          <span slot="label">${_e("avg soh")}</span>
        </ef-tile>
        <ef-tile
          label="Capacity"
          value=${n>0?n.toFixed(1):"—"}
          unit=${n>0?"kWh":""}
        ></ef-tile>
      </div>
    </ef-section>`}renderPerPackThermal(e){return 0===e.length?W`<ef-section .title=${"Per-pack thermal & vitals"}>
        <div class="no-data">No DPU batteries discovered.</div>
      </ef-section>`:W`<ef-section .title=${"Per-pack thermal & vitals"}>
      <div class="pack-grid">${e.map(e=>this.renderDpuBox(e))}</div>
    </ef-section>`}renderDpuBox(e){const t=e.projection,r=t?.packs??[];return W`<div class="dpu-box">
      <div class="dpu-head">
        <div class="dpu-name" title=${e.deviceName}>${e.deviceName}</div>
        <ef-badge tone=${e.online?"ok":"bad"}>${e.online?"online":"offline"}</ef-badge>
      </div>
      ${0===r.length?W`<div class="no-data">
            <ef-badge tone="neutral">no data</ef-badge>
          </div>`:r.map(e=>this.renderPackRow(e))}
    </div>`}renderPackRow(e){const t=this.packTone(e),r=e.maxCellTemp??e.temp,s=e.maxVolDiffMv,o=e.actSoh??e.soh,a=e.soc,i=this.tempClass(r),n=this.spreadClass(s),l=this.sohClass(o);return W`<div class="pack-row" data-tone=${t}>
      <span class="pack-label">Pack ${e.num}</span>
      <span class="pack-vitals">
        <span class="vital ${i}"><span class="k">T</span>${(e=>null==e?"—":`${Math.round(Ae(e))}°F`)(r)}</span>
        <span class="vital ${n}"
          ><span class="k">${_e("cell spread")}</span>${null!=s?`${Math.round(s)} mV`:"—"}</span
        >
        <span class="vital"><span class="k">${_e("soc")}</span>${Se(a,0)}</span>
        <span class="vital ${l}"><span class="k">${_e("soh")}</span>${Se(o,1)}</span>
      </span>
      ${"warn"===t||"bad"===t?W`<ef-badge tone=${this.badgeTone(t)}>${"bad"===t?"!":"·"}</ef-badge>`:W`<span></span>`}
    </div>`}renderDegradation(e){const t=this.deg.data,r=this.deg.stale;if(!t&&!r)return W`<ef-section .title=${"Degradation trend"}>
        <div class="no-data">Computing degradation projection…</div>
      </ef-section>`;if(!t)return W`<ef-section .title=${"Degradation trend"}>
        <ef-badge slot="header" tone="warn">stale data</ef-badge>
        <div class="no-data">Degradation projection unavailable.</div>
      </ef-section>`;const s=t.packs;if(0===s.length)return W`<ef-section .title=${"Degradation trend"}>
        ${r?W`<ef-badge slot="header" tone="warn">stale data</ef-badge>`:V}
        <div class="no-data">No battery packs reporting SoH yet.</div>
      </ef-section>`;const o=t.eolSoh,a=s.filter(e=>null!=e.currentSoh&&e.currentSoh<o+5),i=s.filter(e=>e.peerOutlier),n=s.filter(e=>"projecting"===e.status),l=n.reduce((e,t)=>null==e||(t.yearsToEol??1e9)<(e.yearsToEol??1e9)?t:e,null),c=l&&l.eolDate?new Date(l.eolDate).getFullYear():null,d=[...s].sort((e,t)=>(e.currentSoh??999)-(t.currentSoh??999)),h=d.slice(0,6),p=d.length-h.length,u=a.length>0?W`<ef-badge slot="header" tone="warn">${a.length} flagged</ef-badge>`:V;return W`<ef-section .title=${"Degradation trend"}>
      ${u}${r?W`<ef-badge slot="header" tone="warn">stale data</ef-badge>`:V}
      <div class="deg-list">
        ${h.map(e=>this.renderDegRow(e,o))}
      </div>
      <div class="deg-summary full">
        ${p>0?W`<span>+${p} more pack${1===p?"":"s"}.</span> `:V}
        ${a.length>0?W`<span class="flag"
              >${a.map(e=>`${this.packShortLabel(e)} (${e.currentSoh.toFixed(1)}%)`).join(", ")}
              near ${_e("eol")} floor (${o}%).</span
            > `:V}
        ${i.length>0?W`<span class="flag"
              >${i.map(e=>this.packShortLabel(e)).join(", ")} fading faster than peers.</span
            > `:V}
        ${l&&null!=c?W`<span
              >Projected ${_e("eol")}: ${c}
              (${this.packShortLabel(l)}, ~${l.yearsToEol?.toFixed(1)} yr).</span
            >`:0===n.length?W`<span>Not enough history to project end-of-life yet.</span>`:V}
      </div>
    </ef-section>`}packShortLabel(e){return null!=e.coreNum?`Core ${e.coreNum} · Pack ${e.packNum}`:`${e.device} P${e.packNum}`}renderDegRow(e,t){const r=null==e.currentSoh?"neutral":e.currentSoh<t?"bad":e.currentSoh<t+5?"warn":"ok",s=this.synthSohTrend(e),o=null!=e.fadePctPerYear?`${e.fadePctPerYear.toFixed(1)} %/yr fade`:"learning"===e.status?"still learning":"no-data"===e.status?"no data":"stable",a="bad"===r?"var(--ef-bad)":"warn"===r?"var(--ef-warn)":"var(--ef-accent)";return W`<div class="deg-row" data-tone=${r}>
      <div class="label">
        ${this.packShortLabel(e)}
        <span class="sub">${o}</span>
      </div>
      <div class="full">${ke(s,{width:200,height:32,color:a})}</div>
      <div class="soh-val">
        ${null!=e.currentSoh?`${e.currentSoh.toFixed(1)}%`:"—"}
        ${null!=e.yearsToEol?W`<span class="sub">~${e.yearsToEol.toFixed(1)} yr</span>`:V}
      </div>
    </div>`}renderRoundTripEfficiency(){const e=this.rte.data,t=this.rte.stale;if(!e&&!t)return W`<ef-section .title=${"Round-trip efficiency"}>
        <div class="no-data">Computing round-trip efficiency…</div>
      </ef-section>`;if(!e)return W`<ef-section .title=${"Round-trip efficiency"}>
        <ef-badge slot="header" tone="warn">stale data</ef-badge>
        <div class="no-data">${_e("rte")} unavailable.</div>
      </ef-section>`;const r=e.efficiencyPct,s=null==r?"big":r<80?"big bad":r<88?"big warn":"big",o=e.daysWithData>0?`${e.daysWithData}/${e.windowDays}-day rolling window`:"gathering data — needs charge/discharge cycles",a=e.perDay.filter(e=>null!=e.efficiencyPct).map(e=>({ts:new Date(e.date).getTime(),value:e.efficiencyPct}));return W`<ef-section .title=${"Round-trip efficiency"}>
      ${t?W`<ef-badge slot="header" tone="warn">stale data</ef-badge>`:V}
      <div class="rte-row">
        <div class="rte-headline">
          <div class=${s}>${null!=r?`${r.toFixed(1)}%`:"—"}</div>
          <div class="sub">${_e("rte")}: ${o}</div>
          <div class="sub">Industry avg: 88–92%</div>
        </div>
        <div>
          ${a.length>=2?ke(a,{width:200,height:40,color:"var(--ef-accent)",yMin:70,yMax:100}):W`<div class="no-data">Not enough cycle data yet.</div>`}
        </div>
      </div>
    </ef-section>`}},e.EcoflowBatteryCard.styles=[be,n`
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
        0%,
        100% {
          opacity: 0.3;
        }
        50% {
          opacity: 1;
        }
      }
      .rollup-row {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
        gap: 8px;
        width: 100%;
      }
      /* Per-pack grid: one subsection per DPU, packs stacked as rows. */
      .pack-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 8px;
        width: 100%;
      }
      .dpu-box {
        border: 1px solid var(--ef-line);
        border-radius: 8px;
        background: color-mix(in srgb, var(--ef-panel) 96%, transparent);
        padding: 8px 10px;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .dpu-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 6px;
        margin-bottom: 2px;
      }
      .dpu-name {
        font-size: 0.8rem;
        font-weight: 600;
        color: var(--ef-ink);
        line-height: 1.2;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .pack-row {
        display: grid;
        grid-template-columns: 56px 1fr auto;
        align-items: center;
        gap: 6px;
        padding: 4px 6px;
        border-radius: 6px;
        font-size: 0.78rem;
        line-height: 1.2;
        min-height: 24px;
      }
      .pack-row[data-tone='warn'] {
        background: color-mix(in srgb, var(--ef-warn) 10%, transparent);
      }
      .pack-row[data-tone='bad'] {
        background: color-mix(in srgb, var(--ef-bad) 12%, transparent);
      }
      .pack-row[data-tone='neutral'] {
        opacity: 0.7;
      }
      .pack-label {
        color: var(--ef-muted);
        font-weight: 500;
      }
      .pack-vitals {
        display: flex;
        flex-wrap: wrap;
        gap: 4px 10px;
        font-variant-numeric: tabular-nums;
        color: var(--ef-ink);
      }
      .pack-vitals .vital {
        white-space: nowrap;
      }
      .pack-vitals .vital .k {
        color: var(--ef-muted);
        font-size: 0.68rem;
        margin-right: 2px;
      }
      .vital.warn {
        color: var(--ef-warn);
        font-weight: 600;
      }
      .vital.bad {
        color: var(--ef-bad);
        font-weight: 600;
      }
      /* Degradation: per-pack row with sparkline */
      .deg-list {
        display: flex;
        flex-direction: column;
        gap: 6px;
        width: 100%;
      }
      .deg-row {
        display: grid;
        grid-template-columns: 140px 1fr auto;
        align-items: center;
        gap: 10px;
        padding: 4px 6px;
        border-radius: 6px;
        font-size: 0.78rem;
      }
      .deg-row[data-tone='warn'] {
        background: color-mix(in srgb, var(--ef-warn) 8%, transparent);
      }
      .deg-row[data-tone='bad'] {
        background: color-mix(in srgb, var(--ef-bad) 10%, transparent);
      }
      .deg-row .label {
        font-weight: 500;
        color: var(--ef-ink);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .deg-row .label .sub {
        display: block;
        font-size: 0.65rem;
        color: var(--ef-muted);
        font-weight: 400;
      }
      .deg-row .soh-val {
        font-variant-numeric: tabular-nums;
        font-weight: 600;
        text-align: right;
      }
      .deg-row .soh-val .sub {
        display: block;
        font-size: 0.65rem;
        color: var(--ef-muted);
        font-weight: 400;
      }
      .deg-summary {
        font-size: 0.78rem;
        color: var(--ef-muted);
        margin-top: 6px;
        line-height: 1.4;
      }
      .deg-summary .flag {
        color: var(--ef-warn);
        font-weight: 500;
      }
      .rte-row {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
        width: 100%;
        align-items: center;
      }
      .rte-headline {
        display: flex;
        flex-direction: column;
        gap: 4px;
        font-size: 0.85rem;
        color: var(--ef-ink);
      }
      .rte-headline .big {
        font-size: 1.8rem;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
        line-height: 1;
      }
      .rte-headline .big.warn {
        color: var(--ef-warn);
      }
      .rte-headline .big.bad {
        color: var(--ef-bad);
      }
      .rte-headline .sub {
        font-size: 0.7rem;
        color: var(--ef-muted);
      }
      .no-data {
        font-size: 0.78rem;
        color: var(--ef-muted);
        padding: 6px 0;
      }
      .full {
        width: 100%;
      }
    `],t([fe()],e.EcoflowBatteryCard.prototype,"deg",void 0),t([fe()],e.EcoflowBatteryCard.prototype,"rte",void 0),e.EcoflowBatteryCard=t([de("ecoflow-battery-card")],e.EcoflowBatteryCard),window.customCards=window.customCards||[],window.customCards.push({type:"ecoflow-battery-card",name:"EcoFlow Battery Card",description:"Fleet thermal + degradation + round-trip efficiency for EcoFlow batteries"}),e}({});
//# sourceMappingURL=ecoflow-battery-card.js.map
