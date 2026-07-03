var EcoflowFleetCard=function(e){"use strict";function t(e,t,s,r){var a,i=arguments.length,o=i<3?t:null===r?r=Object.getOwnPropertyDescriptor(t,s):r;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)o=Reflect.decorate(e,t,s,r);else for(var n=e.length-1;n>=0;n--)(a=e[n])&&(o=(i<3?a(o):i>3?a(t,s,o):a(t,s))||o);return i>3&&o&&Object.defineProperty(t,s,o),o}"function"==typeof SuppressedError&&SuppressedError;
/**
     * @license
     * Copyright 2019 Google LLC
     * SPDX-License-Identifier: BSD-3-Clause
     */
const s=globalThis,r=s.ShadowRoot&&(void 0===s.ShadyCSS||s.ShadyCSS.nativeShadow)&&"adoptedStyleSheets"in Document.prototype&&"replace"in CSSStyleSheet.prototype,a=Symbol(),i=new WeakMap;let o=class{constructor(e,t,s){if(this._$cssResult$=!0,s!==a)throw Error("CSSResult is not constructable. Use `unsafeCSS` or `css` instead.");this.cssText=e,this.t=t}get styleSheet(){let e=this.o;const t=this.t;if(r&&void 0===e){const s=void 0!==t&&1===t.length;s&&(e=i.get(t)),void 0===e&&((this.o=e=new CSSStyleSheet).replaceSync(this.cssText),s&&i.set(t,e))}return e}toString(){return this.cssText}};const n=(e,...t)=>{const s=1===e.length?e[0]:t.reduce((t,s,r)=>t+(e=>{if(!0===e._$cssResult$)return e.cssText;if("number"==typeof e)return e;throw Error("Value passed to 'css' function must be a 'css' function result: "+e+". Use 'unsafeCSS' to pass non-literal values, but take care to ensure page security.")})(s)+e[r+1],e[0]);return new o(s,e,a)},l=r?e=>e:e=>e instanceof CSSStyleSheet?(e=>{let t="";for(const s of e.cssRules)t+=s.cssText;return(e=>new o("string"==typeof e?e:e+"",void 0,a))(t)})(e):e,{is:c,defineProperty:d,getOwnPropertyDescriptor:h,getOwnPropertyNames:p,getOwnPropertySymbols:u,getPrototypeOf:f}=Object,v=globalThis,g=v.trustedTypes,m=g?g.emptyScript:"",$=v.reactiveElementPolyfillSupport,b=(e,t)=>e,y={toAttribute(e,t){switch(t){case Boolean:e=e?m:null;break;case Object:case Array:e=null==e?e:JSON.stringify(e)}return e},fromAttribute(e,t){let s=e;switch(t){case Boolean:s=null!==e;break;case Number:s=null===e?null:Number(e);break;case Object:case Array:try{s=JSON.parse(e)}catch(e){s=null}}return s}},w=(e,t)=>!c(e,t),x={attribute:!0,type:String,converter:y,reflect:!1,useDefault:!1,hasChanged:w};
/**
     * @license
     * Copyright 2017 Google LLC
     * SPDX-License-Identifier: BSD-3-Clause
     */Symbol.metadata??=Symbol("metadata"),v.litPropertyMetadata??=new WeakMap;let k=class extends HTMLElement{static addInitializer(e){this._$Ei(),(this.l??=[]).push(e)}static get observedAttributes(){return this.finalize(),this._$Eh&&[...this._$Eh.keys()]}static createProperty(e,t=x){if(t.state&&(t.attribute=!1),this._$Ei(),this.prototype.hasOwnProperty(e)&&((t=Object.create(t)).wrapped=!0),this.elementProperties.set(e,t),!t.noAccessor){const s=Symbol(),r=this.getPropertyDescriptor(e,s,t);void 0!==r&&d(this.prototype,e,r)}}static getPropertyDescriptor(e,t,s){const{get:r,set:a}=h(this.prototype,e)??{get(){return this[t]},set(e){this[t]=e}};return{get:r,set(t){const i=r?.call(this);a?.call(this,t),this.requestUpdate(e,i,s)},configurable:!0,enumerable:!0}}static getPropertyOptions(e){return this.elementProperties.get(e)??x}static _$Ei(){if(this.hasOwnProperty(b("elementProperties")))return;const e=f(this);e.finalize(),void 0!==e.l&&(this.l=[...e.l]),this.elementProperties=new Map(e.elementProperties)}static finalize(){if(this.hasOwnProperty(b("finalized")))return;if(this.finalized=!0,this._$Ei(),this.hasOwnProperty(b("properties"))){const e=this.properties,t=[...p(e),...u(e)];for(const s of t)this.createProperty(s,e[s])}const e=this[Symbol.metadata];if(null!==e){const t=litPropertyMetadata.get(e);if(void 0!==t)for(const[e,s]of t)this.elementProperties.set(e,s)}this._$Eh=new Map;for(const[e,t]of this.elementProperties){const s=this._$Eu(e,t);void 0!==s&&this._$Eh.set(s,e)}this.elementStyles=this.finalizeStyles(this.styles)}static finalizeStyles(e){const t=[];if(Array.isArray(e)){const s=new Set(e.flat(1/0).reverse());for(const e of s)t.unshift(l(e))}else void 0!==e&&t.push(l(e));return t}static _$Eu(e,t){const s=t.attribute;return!1===s?void 0:"string"==typeof s?s:"string"==typeof e?e.toLowerCase():void 0}constructor(){super(),this._$Ep=void 0,this.isUpdatePending=!1,this.hasUpdated=!1,this._$Em=null,this._$Ev()}_$Ev(){this._$ES=new Promise(e=>this.enableUpdating=e),this._$AL=new Map,this._$E_(),this.requestUpdate(),this.constructor.l?.forEach(e=>e(this))}addController(e){(this._$EO??=new Set).add(e),void 0!==this.renderRoot&&this.isConnected&&e.hostConnected?.()}removeController(e){this._$EO?.delete(e)}_$E_(){const e=new Map,t=this.constructor.elementProperties;for(const s of t.keys())this.hasOwnProperty(s)&&(e.set(s,this[s]),delete this[s]);e.size>0&&(this._$Ep=e)}createRenderRoot(){const e=this.shadowRoot??this.attachShadow(this.constructor.shadowRootOptions);return((e,t)=>{if(r)e.adoptedStyleSheets=t.map(e=>e instanceof CSSStyleSheet?e:e.styleSheet);else for(const r of t){const t=document.createElement("style"),a=s.litNonce;void 0!==a&&t.setAttribute("nonce",a),t.textContent=r.cssText,e.appendChild(t)}})(e,this.constructor.elementStyles),e}connectedCallback(){this.renderRoot??=this.createRenderRoot(),this.enableUpdating(!0),this._$EO?.forEach(e=>e.hostConnected?.())}enableUpdating(e){}disconnectedCallback(){this._$EO?.forEach(e=>e.hostDisconnected?.())}attributeChangedCallback(e,t,s){this._$AK(e,s)}_$ET(e,t){const s=this.constructor.elementProperties.get(e),r=this.constructor._$Eu(e,s);if(void 0!==r&&!0===s.reflect){const a=(void 0!==s.converter?.toAttribute?s.converter:y).toAttribute(t,s.type);this._$Em=e,null==a?this.removeAttribute(r):this.setAttribute(r,a),this._$Em=null}}_$AK(e,t){const s=this.constructor,r=s._$Eh.get(e);if(void 0!==r&&this._$Em!==r){const e=s.getPropertyOptions(r),a="function"==typeof e.converter?{fromAttribute:e.converter}:void 0!==e.converter?.fromAttribute?e.converter:y;this._$Em=r;const i=a.fromAttribute(t,e.type);this[r]=i??this._$Ej?.get(r)??i,this._$Em=null}}requestUpdate(e,t,s,r=!1,a){if(void 0!==e){const i=this.constructor;if(!1===r&&(a=this[e]),s??=i.getPropertyOptions(e),!((s.hasChanged??w)(a,t)||s.useDefault&&s.reflect&&a===this._$Ej?.get(e)&&!this.hasAttribute(i._$Eu(e,s))))return;this.C(e,t,s)}!1===this.isUpdatePending&&(this._$ES=this._$EP())}C(e,t,{useDefault:s,reflect:r,wrapped:a},i){s&&!(this._$Ej??=new Map).has(e)&&(this._$Ej.set(e,i??t??this[e]),!0!==a||void 0!==i)||(this._$AL.has(e)||(this.hasUpdated||s||(t=void 0),this._$AL.set(e,t)),!0===r&&this._$Em!==e&&(this._$Eq??=new Set).add(e))}async _$EP(){this.isUpdatePending=!0;try{await this._$ES}catch(e){Promise.reject(e)}const e=this.scheduleUpdate();return null!=e&&await e,!this.isUpdatePending}scheduleUpdate(){return this.performUpdate()}performUpdate(){if(!this.isUpdatePending)return;if(!this.hasUpdated){if(this.renderRoot??=this.createRenderRoot(),this._$Ep){for(const[e,t]of this._$Ep)this[e]=t;this._$Ep=void 0}const e=this.constructor.elementProperties;if(e.size>0)for(const[t,s]of e){const{wrapped:e}=s,r=this[t];!0!==e||this._$AL.has(t)||void 0===r||this.C(t,void 0,s,r)}}let e=!1;const t=this._$AL;try{e=this.shouldUpdate(t),e?(this.willUpdate(t),this._$EO?.forEach(e=>e.hostUpdate?.()),this.update(t)):this._$EM()}catch(t){throw e=!1,this._$EM(),t}e&&this._$AE(t)}willUpdate(e){}_$AE(e){this._$EO?.forEach(e=>e.hostUpdated?.()),this.hasUpdated||(this.hasUpdated=!0,this.firstUpdated(e)),this.updated(e)}_$EM(){this._$AL=new Map,this.isUpdatePending=!1}get updateComplete(){return this.getUpdateComplete()}getUpdateComplete(){return this._$ES}shouldUpdate(e){return!0}update(e){this._$Eq&&=this._$Eq.forEach(e=>this._$ET(e,this[e])),this._$EM()}updated(e){}firstUpdated(e){}};k.elementStyles=[],k.shadowRootOptions={mode:"open"},k[b("elementProperties")]=new Map,k[b("finalized")]=new Map,$?.({ReactiveElement:k}),(v.reactiveElementVersions??=[]).push("2.1.2");
/**
     * @license
     * Copyright 2017 Google LLC
     * SPDX-License-Identifier: BSD-3-Clause
     */
const _=globalThis,S=e=>e,A=_.trustedTypes,P=A?A.createPolicy("lit-html",{createHTML:e=>e}):void 0,E="$lit$",C=`lit$${Math.random().toFixed(9).slice(2)}$`,T="?"+C,M=`<${T}>`,H=document,j=()=>H.createComment(""),W=e=>null===e||"object"!=typeof e&&"function"!=typeof e,z=Array.isArray,O="[ \t\n\f\r]",R=/<(?:(!--|\/[^a-zA-Z])|(\/?[a-zA-Z][^>\s]*)|(\/?$))/g,U=/-->/g,N=/>/g,F=RegExp(`>|${O}(?:([^\\s"'>=/]+)(${O}*=${O}*(?:[^ \t\n\f\r"'\`<>=]|("|')|))|$)`,"g"),L=/'/g,D=/"/g,B=/^(?:script|style|textarea|title)$/i,I=e=>(t,...s)=>({_$litType$:e,strings:t,values:s}),V=I(1),q=I(2),G=Symbol.for("lit-noChange"),K=Symbol.for("lit-nothing"),J=new WeakMap,Z=H.createTreeWalker(H,129);function Q(e,t){if(!z(e)||!e.hasOwnProperty("raw"))throw Error("invalid template strings array");return void 0!==P?P.createHTML(t):t}const X=(e,t)=>{const s=e.length-1,r=[];let a,i=2===t?"<svg>":3===t?"<math>":"",o=R;for(let t=0;t<s;t++){const s=e[t];let n,l,c=-1,d=0;for(;d<s.length&&(o.lastIndex=d,l=o.exec(s),null!==l);)d=o.lastIndex,o===R?"!--"===l[1]?o=U:void 0!==l[1]?o=N:void 0!==l[2]?(B.test(l[2])&&(a=RegExp("</"+l[2],"g")),o=F):void 0!==l[3]&&(o=F):o===F?">"===l[0]?(o=a??R,c=-1):void 0===l[1]?c=-2:(c=o.lastIndex-l[2].length,n=l[1],o=void 0===l[3]?F:'"'===l[3]?D:L):o===D||o===L?o=F:o===U||o===N?o=R:(o=F,a=void 0);const h=o===F&&e[t+1].startsWith("/>")?" ":"";i+=o===R?s+M:c>=0?(r.push(n),s.slice(0,c)+E+s.slice(c)+C+h):s+C+(-2===c?t:h)}return[Q(e,i+(e[s]||"<?>")+(2===t?"</svg>":3===t?"</math>":"")),r]};class Y{constructor({strings:e,_$litType$:t},s){let r;this.parts=[];let a=0,i=0;const o=e.length-1,n=this.parts,[l,c]=X(e,t);if(this.el=Y.createElement(l,s),Z.currentNode=this.el.content,2===t||3===t){const e=this.el.content.firstChild;e.replaceWith(...e.childNodes)}for(;null!==(r=Z.nextNode())&&n.length<o;){if(1===r.nodeType){if(r.hasAttributes())for(const e of r.getAttributeNames())if(e.endsWith(E)){const t=c[i++],s=r.getAttribute(e).split(C),o=/([.?@])?(.*)/.exec(t);n.push({type:1,index:a,name:o[2],strings:s,ctor:"."===o[1]?ae:"?"===o[1]?ie:"@"===o[1]?oe:re}),r.removeAttribute(e)}else e.startsWith(C)&&(n.push({type:6,index:a}),r.removeAttribute(e));if(B.test(r.tagName)){const e=r.textContent.split(C),t=e.length-1;if(t>0){r.textContent=A?A.emptyScript:"";for(let s=0;s<t;s++)r.append(e[s],j()),Z.nextNode(),n.push({type:2,index:++a});r.append(e[t],j())}}}else if(8===r.nodeType)if(r.data===T)n.push({type:2,index:a});else{let e=-1;for(;-1!==(e=r.data.indexOf(C,e+1));)n.push({type:7,index:a}),e+=C.length-1}a++}}static createElement(e,t){const s=H.createElement("template");return s.innerHTML=e,s}}function ee(e,t,s=e,r){if(t===G)return t;let a=void 0!==r?s._$Co?.[r]:s._$Cl;const i=W(t)?void 0:t._$litDirective$;return a?.constructor!==i&&(a?._$AO?.(!1),void 0===i?a=void 0:(a=new i(e),a._$AT(e,s,r)),void 0!==r?(s._$Co??=[])[r]=a:s._$Cl=a),void 0!==a&&(t=ee(e,a._$AS(e,t.values),a,r)),t}class te{constructor(e,t){this._$AV=[],this._$AN=void 0,this._$AD=e,this._$AM=t}get parentNode(){return this._$AM.parentNode}get _$AU(){return this._$AM._$AU}u(e){const{el:{content:t},parts:s}=this._$AD,r=(e?.creationScope??H).importNode(t,!0);Z.currentNode=r;let a=Z.nextNode(),i=0,o=0,n=s[0];for(;void 0!==n;){if(i===n.index){let t;2===n.type?t=new se(a,a.nextSibling,this,e):1===n.type?t=new n.ctor(a,n.name,n.strings,this,e):6===n.type&&(t=new ne(a,this,e)),this._$AV.push(t),n=s[++o]}i!==n?.index&&(a=Z.nextNode(),i++)}return Z.currentNode=H,r}p(e){let t=0;for(const s of this._$AV)void 0!==s&&(void 0!==s.strings?(s._$AI(e,s,t),t+=s.strings.length-2):s._$AI(e[t])),t++}}class se{get _$AU(){return this._$AM?._$AU??this._$Cv}constructor(e,t,s,r){this.type=2,this._$AH=K,this._$AN=void 0,this._$AA=e,this._$AB=t,this._$AM=s,this.options=r,this._$Cv=r?.isConnected??!0}get parentNode(){let e=this._$AA.parentNode;const t=this._$AM;return void 0!==t&&11===e?.nodeType&&(e=t.parentNode),e}get startNode(){return this._$AA}get endNode(){return this._$AB}_$AI(e,t=this){e=ee(this,e,t),W(e)?e===K||null==e||""===e?(this._$AH!==K&&this._$AR(),this._$AH=K):e!==this._$AH&&e!==G&&this._(e):void 0!==e._$litType$?this.$(e):void 0!==e.nodeType?this.T(e):(e=>z(e)||"function"==typeof e?.[Symbol.iterator])(e)?this.k(e):this._(e)}O(e){return this._$AA.parentNode.insertBefore(e,this._$AB)}T(e){this._$AH!==e&&(this._$AR(),this._$AH=this.O(e))}_(e){this._$AH!==K&&W(this._$AH)?this._$AA.nextSibling.data=e:this.T(H.createTextNode(e)),this._$AH=e}$(e){const{values:t,_$litType$:s}=e,r="number"==typeof s?this._$AC(e):(void 0===s.el&&(s.el=Y.createElement(Q(s.h,s.h[0]),this.options)),s);if(this._$AH?._$AD===r)this._$AH.p(t);else{const e=new te(r,this),s=e.u(this.options);e.p(t),this.T(s),this._$AH=e}}_$AC(e){let t=J.get(e.strings);return void 0===t&&J.set(e.strings,t=new Y(e)),t}k(e){z(this._$AH)||(this._$AH=[],this._$AR());const t=this._$AH;let s,r=0;for(const a of e)r===t.length?t.push(s=new se(this.O(j()),this.O(j()),this,this.options)):s=t[r],s._$AI(a),r++;r<t.length&&(this._$AR(s&&s._$AB.nextSibling,r),t.length=r)}_$AR(e=this._$AA.nextSibling,t){for(this._$AP?.(!1,!0,t);e!==this._$AB;){const t=S(e).nextSibling;S(e).remove(),e=t}}setConnected(e){void 0===this._$AM&&(this._$Cv=e,this._$AP?.(e))}}class re{get tagName(){return this.element.tagName}get _$AU(){return this._$AM._$AU}constructor(e,t,s,r,a){this.type=1,this._$AH=K,this._$AN=void 0,this.element=e,this.name=t,this._$AM=r,this.options=a,s.length>2||""!==s[0]||""!==s[1]?(this._$AH=Array(s.length-1).fill(new String),this.strings=s):this._$AH=K}_$AI(e,t=this,s,r){const a=this.strings;let i=!1;if(void 0===a)e=ee(this,e,t,0),i=!W(e)||e!==this._$AH&&e!==G,i&&(this._$AH=e);else{const r=e;let o,n;for(e=a[0],o=0;o<a.length-1;o++)n=ee(this,r[s+o],t,o),n===G&&(n=this._$AH[o]),i||=!W(n)||n!==this._$AH[o],n===K?e=K:e!==K&&(e+=(n??"")+a[o+1]),this._$AH[o]=n}i&&!r&&this.j(e)}j(e){e===K?this.element.removeAttribute(this.name):this.element.setAttribute(this.name,e??"")}}class ae extends re{constructor(){super(...arguments),this.type=3}j(e){this.element[this.name]=e===K?void 0:e}}class ie extends re{constructor(){super(...arguments),this.type=4}j(e){this.element.toggleAttribute(this.name,!!e&&e!==K)}}class oe extends re{constructor(e,t,s,r,a){super(e,t,s,r,a),this.type=5}_$AI(e,t=this){if((e=ee(this,e,t,0)??K)===G)return;const s=this._$AH,r=e===K&&s!==K||e.capture!==s.capture||e.once!==s.once||e.passive!==s.passive,a=e!==K&&(s===K||r);r&&this.element.removeEventListener(this.name,this,s),a&&this.element.addEventListener(this.name,this,e),this._$AH=e}handleEvent(e){"function"==typeof this._$AH?this._$AH.call(this.options?.host??this.element,e):this._$AH.handleEvent(e)}}class ne{constructor(e,t,s){this.element=e,this.type=6,this._$AN=void 0,this._$AM=t,this.options=s}get _$AU(){return this._$AM._$AU}_$AI(e){ee(this,e)}}const le=_.litHtmlPolyfillSupport;le?.(Y,se),(_.litHtmlVersions??=[]).push("3.3.3");const ce=globalThis;
/**
     * @license
     * Copyright 2017 Google LLC
     * SPDX-License-Identifier: BSD-3-Clause
     */class de extends k{constructor(){super(...arguments),this.renderOptions={host:this},this._$Do=void 0}createRenderRoot(){const e=super.createRenderRoot();return this.renderOptions.renderBefore??=e.firstChild,e}update(e){const t=this.render();this.hasUpdated||(this.renderOptions.isConnected=this.isConnected),super.update(e),this._$Do=((e,t,s)=>{const r=s?.renderBefore??t;let a=r._$litPart$;if(void 0===a){const e=s?.renderBefore??null;r._$litPart$=a=new se(t.insertBefore(j(),e),e,void 0,s??{})}return a._$AI(e),a})(t,this.renderRoot,this.renderOptions)}connectedCallback(){super.connectedCallback(),this._$Do?.setConnected(!0)}disconnectedCallback(){super.disconnectedCallback(),this._$Do?.setConnected(!1)}render(){return G}}de._$litElement$=!0,de.finalized=!0,ce.litElementHydrateSupport?.({LitElement:de});const he=ce.litElementPolyfillSupport;he?.({LitElement:de}),(ce.litElementVersions??=[]).push("4.2.2");
/**
     * @license
     * Copyright 2017 Google LLC
     * SPDX-License-Identifier: BSD-3-Clause
     */
const pe={attribute:!0,type:String,converter:y,reflect:!1,hasChanged:w},ue=(e=pe,t,s)=>{const{kind:r,metadata:a}=s;let i=globalThis.litPropertyMetadata.get(a);if(void 0===i&&globalThis.litPropertyMetadata.set(a,i=new Map),"setter"===r&&((e=Object.create(e)).wrapped=!0),i.set(s.name,e),"accessor"===r){const{name:r}=s;return{set(s){const a=t.get.call(this);t.set.call(this,s),this.requestUpdate(r,a,e,!0,s)},init(t){return void 0!==t&&this.C(r,void 0,e,t),t}}}if("setter"===r){const{name:r}=s;return function(s){const a=this[r];t.call(this,s),this.requestUpdate(r,a,e,!0,s)}}throw Error("Unsupported decorator location: "+r)};
/**
     * @license
     * Copyright 2017 Google LLC
     * SPDX-License-Identifier: BSD-3-Clause
     */function fe(e){return(t,s)=>"object"==typeof s?ue(e,t,s):((e,t,s)=>{const r=t.hasOwnProperty(s);return t.constructor.createProperty(s,e),r?Object.getOwnPropertyDescriptor(t,s):void 0})(e,t,s)}
/**
     * @license
     * Copyright 2017 Google LLC
     * SPDX-License-Identifier: BSD-3-Clause
     */function ve(e){return fe({...e,state:!0,attribute:!1})}const ge=new Map,me=[1e3,2e3,4e3,8e3,16e3,3e4];function $e(e,t={}){const s=t.wsCtor??("undefined"!=typeof WebSocket?WebSocket:void 0),r=t.fetchImpl??("undefined"!=typeof fetch?fetch:void 0);let a=null,i="idle",o=null,n=0,l=null,c=null,d=!1,h=!1;const p=new Set,u=()=>{for(const e of p)try{e(a)}catch(e){"undefined"!=typeof console&&console.warn("[ecoflow] snapshot subscriber threw",e)}},f=e=>{i!==e&&(i=e,u())},v=()=>{null!=l&&(clearTimeout(l),l=null)},g=()=>{null!=c&&(clearTimeout(c),c=null)},m=()=>{if(v(),o){o.onopen=null,o.onmessage=null,o.onerror=null,o.onclose=null;try{o.close()}catch{}o=null}},$=()=>{if(d||!s)return;let t;v(),f("idle"===i?"connecting":"reconnecting");try{t=new s(function(e){let t=e.trim().replace(/\/$/,"");return/^https?:\/\//i.test(t)?t=t.replace(/^http/i,"ws"):/^wss?:\/\//i.test(t)||(t=`ws://${t}`),`${t}/ws`}(e))}catch{return void b()}o=t,t.onopen=()=>{d||o!==t||(n=0,f("open"),(()=>{if(h||!r)return;h=!0;const t=function(e,t){let s=e.trim().replace(/\/$/,"");return/^wss?:\/\//i.test(s)?s=s.replace(/^ws/i,"http"):/^https?:\/\//i.test(s)||(s=`http://${s}`),`${s}${t.startsWith("/")?t:`/${t}`}`}(e,"/api/snapshot");r(t).then(e=>e.ok?e.json():null).then(e=>{!d&&e&&null==a&&(a=e,u())}).catch(()=>{})})())},t.onmessage=e=>{if(!d&&o===t)try{const t=JSON.parse("string"==typeof e.data?e.data:"");t&&"snapshot"===t.type&&t.data&&(a=t.data,u())}catch{}},t.onerror=()=>{},t.onclose=()=>{o===t&&(o=null,d?f("closed"):b())}},b=()=>{if(d)return;f("reconnecting");const e=Math.min(n,me.length-1);n+=1,l=setTimeout(()=>{l=null,$()},me[e])},y={getSnapshot:()=>a,connectionState:()=>i,subscribe(t){g(),p.add(t);try{t(a)}catch(e){"undefined"!=typeof console&&console.warn("[ecoflow] snapshot subscriber threw",e)}return 1===p.size&&null==o&&"open"!==i&&"connecting"!==i&&"reconnecting"!==i&&$(),()=>{p.delete(t)&&0===p.size&&(g(),c=setTimeout(()=>{c=null,0===p.size&&(m(),n=0,h=!1,f("idle"),ge.get(e)===y&&ge.delete(e))},5e3))}},_destroy(){d=!0,g(),m(),f("closed"),p.clear(),ge.get(e)===y&&ge.delete(e)}};return y}class be extends de{constructor(){super(...arguments),this.snapshot=null,this.connState="idle",this._unsubscribe=null,this._stateTimer=null}setConfig(e){if(!e)throw new Error("Invalid config");this.config={host:e.host||"http://homeassistant.local:8787",title:e.title||"Power",refresh_seconds:e.refresh_seconds??30,type:e.type}}effectiveHost(){return this.config?.host||"http://homeassistant.local:8787"}connectedCallback(){super.connectedCallback();const e=function(e){const t=ge.get(e);if(t)return t;const s=$e(e);return ge.set(e,s),s}(this.effectiveHost());this.connState=e.connectionState(),this._unsubscribe=e.subscribe(t=>{this.snapshot=t,this.connState=e.connectionState()})}disconnectedCallback(){super.disconnectedCallback(),this._unsubscribe&&this._unsubscribe(),this._unsubscribe=null,this._stateTimer&&(clearInterval(this._stateTimer),this._stateTimer=null)}getCardSize(){return 6}}t([fe({attribute:!1})],be.prototype,"config",void 0),t([ve()],be.prototype,"snapshot",void 0),t([ve()],be.prototype,"connState",void 0);const ye=n`
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
`;function we(e){return{critical:e.filter(e=>"critical"===e.severity).length,warning:e.filter(e=>"warning"===e.severity).length,info:e.filter(e=>"info"===e.severity).length}}function xe(e){const t=e.match(/(\d+)\s*$/);return t?Number(t[1]):null}function ke(e,t){const s=e=>{const t=(e.productName??"").toLowerCase();return t.includes("smart home panel")?0:t.includes("delta pro ultra")?1:t.includes("delta 3 plus")?2:3},r=s(e),a=s(t);if(r!==a)return r-a;if(1===r){const s=xe(e.deviceName),r=xe(t.deviceName);if(null!=s&&null!=r)return s-r;if(null!=s)return-1;if(null!=r)return 1}return e.deviceName.localeCompare(t.deviceName)}const _e=e=>null==e?"—":Math.abs(e)>=1e3?`${(e/1e3).toFixed(2)} kW`:`${Math.round(e)} W`,Se=(e,t=0)=>null==e?"—":`${e.toFixed(t)}%`,Ae=e=>null==e?"—":`${Math.round((e=>9*e/5+32)(e))}°F`,Pe=e=>{if(null==e)return"—";if(e<60)return`${Math.round(e)} min`;const t=Math.floor(e/60),s=Math.round(e%60);if(t<24)return`${t}h ${s}m`;return`${Math.floor(t/24)}d ${t%24}h`},Ee={};function Ce(e,t){for(const s of e.split("|"))Ee[s.trim()]=t}function Te(e){const t=function(e){const t=function(e){return e.split("·")[0].split("(")[0].replace(/\s+/g," ").trim().toLowerCase()}(e);return t?Ee[t]:void 0}(e);return t?V`<span class="ef-glossary"
    >${e}<span class="ef-tooltip" role="tooltip">${t}</span></span
  >`:e}function Me(e,t,s,r){const a=t-e||1,i=r-s;return t=>s+(t-e)/a*i}function He(e,t,s){const r=[];let a=!1;for(const i of e){if(null==i.value||!Number.isFinite(i.value)){a=!1;continue}const e=t(i.ts),o=s(i.value);r.push(`${a?"L":"M"} ${e.toFixed(1)} ${o.toFixed(1)}`),a=!0}return r.join(" ")}function je(e,t={}){const s=t.width??720,r=t.height??220,a=36,i=10,o=s-a-36,n=r-i-22,l=[...e.area?.points??[],...e.line?.points??[],...e.rightLine?.points??[]];if(l.length<2)return V`<div style="height:${r}px;color:var(--ef-muted);font-size:11px;display:flex;align-items:center;justify-content:center;">no forecast data</div>`;const c=l.map(e=>e.ts),d=Math.min(...c),h=Math.max(...c),p=[];e.area&&p.push(...e.area.points.map(e=>e.value).filter(e=>null!=e)),e.line&&p.push(...e.line.points.map(e=>e.value).filter(e=>null!=e));const u=t.yMax??1.05*Math.max(100,...p),f=Math.min(0,...p),v=Me(d,h,a,a+o),g=Me(f,u,i+n,i),m=Me(0,100,i+n,i),$=g(0),b=216e5,y=[];for(let e=Math.ceil(d/b)*b;e<=h;e+=b){const t=v(e);y.push(q`<line x1=${t} x2=${t} y1=${i} y2=${i+n} stroke="var(--ef-line)" stroke-dasharray="2 3" stroke-opacity=".6" />`)}const w=[0,u/2,u].map(e=>({v:e,y:g(e)})),x=[0,50,100].map(e=>({v:e,y:m(e)})),k=e.area?function(e,t,s,r){const a=He(e,t,s);if(!a)return"";let i=null,o=null;for(const s of e)if(null!=s.value&&Number.isFinite(s.value)){const e=t(s.ts);null==i&&(i=e),o=e}return null==i||null==o?"":`${a} L ${o.toFixed(1)} ${r.toFixed(1)} L ${i.toFixed(1)} ${r.toFixed(1)} Z`}(e.area.points,v,g,$):"",_=e.line?He(e.line.points,v,g):"",S=e.rightLine?He(e.rightLine.points,v,m):"",A=e.rightRef?m(e.rightRef.value):null,P="display:inline-block;width:14px;height:2px;margin-right:4px;vertical-align:middle",E=V`<div style="display:flex;flex-wrap:wrap;gap:10px;font-size:11px;color:var(--ef-muted);margin-top:4px;">${e.area?.label?V`<span><span style="${"display:inline-block;width:10px;height:10px;opacity:.6;border-radius:2px;margin-right:4px"};background:${e.area.color};"></span>${e.area.label}</span>`:null}${e.line?.label?V`<span><span style="${P};background:${e.line.color};"></span>${e.line.label}</span>`:null}${e.rightLine?.label?V`<span><span style="${P};background:${e.rightLine.color};"></span>${e.rightLine.label}</span>`:null}</div>`;return V`<svg viewBox="0 0 ${s} ${r}" width="100%" height=${r} preserveAspectRatio="none" aria-hidden="true">${y}${w.map(e=>q`<line x1=${a} x2=${a+o} y1=${e.y} y2=${e.y} stroke="var(--ef-line)" stroke-opacity=".4" /><text x=${32} y=${e.y+3} text-anchor="end" font-size="9" fill="var(--ef-muted)">${(e.v/1e3).toFixed(1)}k</text>`)}${x.map(e=>q`<text x=${a+o+4} y=${e.y+3} text-anchor="start" font-size="9" fill="var(--ef-muted)">${e.v.toFixed(0)}%</text>`)}${null!=A?q`<line x1=${a} x2=${a+o} y1=${A} y2=${A} stroke=${e.rightRef.color} stroke-dasharray="4 4" stroke-opacity=".7" />`:null}${k?q`<path d=${k} fill=${e.area.color} fill-opacity=".35" stroke="none" />`:null}${_?q`<path d=${_} fill="none" stroke=${e.line.color} stroke-width="1.6" />`:null}${S?q`<path d=${S} fill="none" stroke=${e.rightLine.color} stroke-width="2" />`:null}</svg>${E}`}Ce("soc|state of charge","State of charge — how full the battery is right now, 0–100%."),Ce("avg soc","Average state of charge across every online battery pack in the fleet."),Ce("soh|state of health|avg soh","State of health — measured usable capacity vs the pack’s original design capacity. A wear gauge; 100% = like-new."),Ce("ocv|open-circuit","Open-circuit voltage — the pack’s resting voltage with no load applied."),Ce("cell spread|worst cell spread|cell imbalance|cell spread now","Cell-voltage spread — the gap between the highest and lowest cell in a pack. A widening gap is an early sign of imbalance."),Ce("cell mean","Average voltage across all of the pack’s cells."),Ce("pack volt","Pack terminal voltage."),Ce("rep temp","Representative pack temperature reported by the BMS."),Ce("cell max|cell min","Hottest / coldest individual cell temperature in the pack."),Ce("cell temperatures","Per-cell temperature sensors inside the pack."),Ce("cell voltages","Per-cell voltage, each shown with its deviation from the pack mean."),Ce("mos max|mosfet temperatures|mosfet temps|mosfet","Power-MOSFET temperature — the BMS switching transistors."),Ce("board","BMS circuit-board temperature."),Ce("shunt","Current-shunt temperature — the precision resistor the BMS measures pack current across."),Ce("ptc heater temperatures|ptc heater temps|ptc","PTC heater temperature — keeps the cells warm enough to charge safely in the cold."),Ce("cycles","Equivalent full charge/discharge cycles the pack has completed — a measure of battery age."),Ce("lifetime throughput","Total energy ever charged into and discharged out of the pack."),Ce("capacity","Energy the battery can store, in kWh."),Ce("balancing|cells balancing","The BMS is equalizing cell voltages — routine housekeeping, no action needed."),Ce("hottest pack","The warmest pack across the fleet right now."),Ce("vitals","The pack’s key live readings at a glance."),Ce("pv|pv in|pv total|photovoltaic","Photovoltaic — solar-panel power."),Ce("pv high mppt|pv low mppt","Power from one of the DPU’s two solar strings (high- or low-voltage MPPT input)."),Ce("ac out|ac output","AC power flowing out of the inverter to your loads."),Ce("ac in","AC power flowing into the inverter — grid or generator charging."),Ce("ac out freq / v","Inverter AC output frequency (Hz) and voltage."),Ce("total in / out","Total power into and out of the DPU across every input and output."),Ce("battery v / a","Internal battery-bus voltage and current."),Ce("in|out","Power flowing in to / out of the device."),Ce("input|output","Power flowing into (charging) or out of (discharging) the pack."),Ce("panel load","Total power the SHP2’s circuits are drawing right now."),Ce("live contribution|live draw","Power this device is feeding/drawing right now."),Ce("voltage|current","Live electrical voltage / current at this input."),Ce("v × a","Voltage × current — instantaneous power, shown as a cross-check on the reported watts."),Ce("string ω","Effective resistance (volts ÷ amps) at the MPPT string’s operating point."),Ce("mppt|mppt temp|mppt hv|mppt lv|hv mppt|lv mppt","MPPT — the solar charge controller (Maximum Power Point Tracker). Each DPU has two: a high-voltage and a low-voltage string input."),Ce("hv channels|lv channels","High-/low-voltage MPPT solar string inputs — one of each per DPU."),Ce("ghi","Global Horizontal Irradiance — total sunlight energy on a flat surface (W/m²); the raw “how sunny” number the forecast is built from."),Ce("producing now","Solar power being generated right now."),Ce("peak today","The highest solar power reached so far today."),Ce("coefficient|peak response|response coefficient","Learned response coefficient — watts of PV produced per W/m² of sunlight. Captures panel size, orientation, shading and inverter clipping."),Ce("strongest hour","The hour of day your arrays convert sunlight to power most efficiently — reveals their orientation."),Ce("observed peak pv","The highest PV output actually recorded at this hour-of-day."),Ce("soiling","Dust/pollen on the panels cutting output. Detected by comparing clear-sky production to the cleanest day on record."),Ce("output drop","How far clear-sky solar output has fallen below the clean-panel baseline — the soiling indicator."),Ce("backup|backup pool","SHP2 backup pool — the combined battery the Smart Home Panel draws on."),Ce("backup %","Backup-pool state of charge, trended over the last hour."),Ce("reserve floor|backup reserve|reserve","Reserve floor — the state of charge held back for backup. Loads begin shedding below it."),Ce("solar reserve","Target state of charge to keep in reserve specifically when running on solar."),Ce("mid-priority floor","The SoC at which mid-priority circuits are cut to protect the battery."),Ce("charge power","Power currently flowing into the battery."),Ce("charge time","Estimated time to fully charge the battery."),Ce("rated power","The device’s rated maximum power output."),Ce("ems bat temp","Battery temperature as reported by the SHP2’s energy-management system."),Ce("hw link","Hardware (wired) link status between the SHP2 and this DPU."),Ce("load-shed strategy","The SHP2’s automatic plan for dropping circuits as the battery depletes."),Ce("smart backup mode","The SHP2’s backup-behaviour mode setting."),Ce("charge schedule","The SHP2’s time-of-use scheduled charging windows."),Ce("error code|direct errors|shp2 errors","Device-reported error code — 0 means no fault."),Ce("charging power","Power the EV charger is drawing, over the last 24 hours."),Ce("sessions today","Charging sessions detected today — a sustained draw above 1 kW."),Ce("host dpu|dpu battery","The Delta Pro Ultra the EV charger is wired to — that DPU’s AC output equals the charging draw."),Ce("direct telemetry","Raw data straight from the device over MQTT, rather than inferred."),Ce("solar next 24 h|solar next 24h","Projected solar production, from the cloud forecast run through your learned array model."),Ce("forecast load|forecast load 24 h|typical solar / day","Projected household load from the typical-day consumption curve."),Ce("forecast pv","Projected PV output for this hour."),Ce("projected low soc","The lowest the battery is forecast to reach over the next 24 hours."),Ce("cloud cover","Forecast cloud cover — what derates the solar prediction each hour."),Ce("outlook","At-a-glance battery comfort vs the reserve floor: Comfortable, Watch or Tight."),Ce("history depth","Days of recorded data behind the forecast and learned models — they sharpen as it grows."),Ce("confidence","How trustworthy the learned model is, based on how many samples it has."),Ce("z-score|peer z-score","Modified z-score — how many robust deviations a reading sits from normal. Higher = more anomalous; ≥ 3.5 flags, ≥ 5 warns."),Ce("fit quality|fit r²","R-squared — how well the trend line fits the data, 0–1. Higher means a more trustworthy projection."),Ce("samples|regression samples","How many data points the estimate is built from — more points, more reliable."),Ce("sibling median","The median reading across the pack’s four siblings — the “normal” this pack is compared against."),Ce("this pack","This pack’s current reading."),Ce("deviation","How far this reading sits from the expected/normal value."),Ce("baseline window","The span of history and number of samples behind the self-baseline."),Ce("decline rate|rise rate","How fast the value is changing, per unit time."),Ce("end-of-life|eol|projected eol|reaches 80%","End of life — the 80%-SoH point where a pack has lost a fifth of its original capacity; the conventional LFP replacement mark."),Ce("fade rate|fade / yr|avg fade rate","How fast measured capacity (State of Health) is falling — SoH percentage points lost per year."),Ce("service left|years left|years to eol","Projected years of service remaining before the pack reaches the 80% end-of-life threshold."),Ce("eol threshold","The State of Health at which a pack counts as end-of-life — conventionally 80% for LFP cells."),Ce("packs projecting","How many packs have a firm enough SoH trend to project an end-of-life date."),Ce("soonest eol","The pack across the fleet projected to reach end-of-life first."),Ce("cycles at eol","Projected equivalent full-cycle count by the time the pack reaches end-of-life."),Ce("data span","Days of recorded history the projection is regressed over."),Ce("projection notes","Plain-language end-of-life verdict for each pack with a firm fade trend."),Ce("trend","Whether a pack has a projected fade trend, is stable, is still learning, or has no data yet."),Ce("critical","Critical — an immediate problem that needs attention now."),Ce("warnings|warning","Warning — something to investigate soon."),Ce("informational|info","Informational — noted for awareness, not urgent."),Ce("anomalies","Things unusual right now — flagged by peer comparison and self-baseline."),Ce("forecasts","Where things are heading — runtime, degradation and day-ahead projections."),Ce("actionable","Critical + warning items that may need attention."),Ce("recently cleared","Alerts that were raised and have since resolved, with how long each lasted."),Ce("today","Energy totals since local midnight."),Ce("solar produced","Total solar energy harvested today."),Ce("batteries","Net battery energy today — negative means net charged, positive means net discharged.");class We extends de{constructor(){super(...arguments),this.tone="neutral"}render(){return V`<slot></slot>`}}We.styles=[ye,n`
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
    `],t([fe({reflect:!0})],We.prototype,"tone",void 0),customElements.get("ef-badge")||customElements.define("ef-badge",We);class ze extends de{constructor(){super(...arguments),this.label="",this.value="",this.unit=""}render(){return V`
      <div class="label"><slot name="label">${this.label}</slot></div>
      <div class="value-line">
        <span class="value"><slot name="value">${this.value}</slot></span>
        ${this.unit?V`<span class="unit">${this.unit}</span>`:null}
      </div>
      <slot></slot>
    `}}ze.styles=[ye,n`
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
    `],t([fe()],ze.prototype,"label",void 0),t([fe()],ze.prototype,"value",void 0),t([fe()],ze.prototype,"unit",void 0),customElements.get("ef-tile")||customElements.define("ef-tile",ze);class Oe extends de{constructor(){super(...arguments),this.title=""}render(){return V`
      <header>
        <div class="title"><slot name="title">${this.title}</slot></div>
        <div class="header-extra"><slot name="header"></slot></div>
      </header>
      <div class="body"><slot></slot></div>
    `}}Oe.styles=[ye,n`
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
    `],t([fe()],Oe.prototype,"title",void 0),customElements.get("ef-section")||customElements.define("ef-section",Oe);e.EcoflowFleetCard=class extends be{constructor(){super(...arguments),this.runway={data:null,stale:!1},this.today={data:null,stale:!1},this.forecast={data:null,stale:!1},this._httpTimer=null}connectedCallback(){super.connectedCallback(),this._kickHttpFetches();const e=Math.max(10,this.config?.refresh_seconds??30);this._httpTimer=setInterval(()=>this._kickHttpFetches(),1e3*e)}disconnectedCallback(){super.disconnectedCallback(),this._httpTimer&&(clearInterval(this._httpTimer),this._httpTimer=null)}_kickHttpFetches(){this._fetchOne("/api/runway",()=>this.runway,e=>this.runway=e),this._fetchOne("/api/summary/today",()=>this.today,e=>this.today=e),this._fetchOne("/api/forecast",()=>this.forecast,e=>this.forecast=e)}async _fetchOne(e,t,s){try{const t=this.effectiveHost().replace(/\/$/,"")+e,r=await fetch(t);if(!r.ok)throw new Error(`HTTP ${r.status}`);s({data:await r.json(),stale:!1})}catch{s({...t(),stale:!0})}}connTone(e){return"open"===e?"ok":"connecting"===e||"reconnecting"===e?"warn":"closed"===e?"bad":"neutral"}connLabel(e){return"open"===e?"live":"connecting"===e?"linking":"reconnecting"===e?"reconnecting":"closed"===e?"offline":"idle"}socColor(e){return null==e?"var(--ef-muted)":e>=50?"var(--ef-ok)":e>=25?"var(--ef-warn)":"var(--ef-bad)"}render(){const e=this.snapshot,t=this.config?.title??"Power";if(!e)return V`<ha-card>
<div class="header"><div>
<div class="title">${t}</div>
<div class="subtitle">${this.effectiveHost()}</div>
</div>
<div class="badges"><ef-badge tone=${this.connTone(this.connState)}>${this.connLabel(this.connState)}</ef-badge></div>
</div>
<div class="skeleton"><span class="dot"></span>Connecting to add-on…</div>
</ha-card>`;const s=Object.values(e.devices),r=function(e){return[...e].sort(ke)}(s),a=r.find(e=>"shp2"===e.projection?.kind),i=r.filter(e=>e.productName.toLowerCase().includes("delta pro ultra")),o=r.filter(e=>e!==a&&!i.includes(e)).sort((e,t)=>Number(t.online)-Number(e.online)),n=e.alerts??[],l=we(n),c=s.filter(e=>e.online).length,d=(e=>{if(!e)return"never";const t=Math.floor((Date.now()-e)/1e3);return t<60?`${t}s ago`:t<3600?`${Math.floor(t/60)}m ago`:`${Math.floor(t/3600)}h ago`})(e.generatedAt??null);return V`<ha-card>
<div class="header"><div>
<div class="title">${t}</div>
<div class="subtitle">${s.length} devices · ${c} online · updated ${d}</div>
</div>
<div class="badges">${l.critical>0?V`<ef-badge tone="bad">${l.critical} crit</ef-badge>`:K}${l.warning>0?V`<ef-badge tone="warn">${l.warning} warn</ef-badge>`:K}<ef-badge tone=${this.connTone(this.connState)}>${this.connLabel(this.connState)}</ef-badge></div>
</div>
${this.renderStatusBanner(n)}
${this.renderEnergyFlow(s)}
${this.renderTopRow()}
${this.renderDeviceGrid(a,i,o)}
${this.renderForecast()}
</ha-card>`}renderStatusBanner(e){const t=we(e),s=e.filter(e=>"info"!==e.severity),r=e.filter(e=>"info"===e.severity);if(0===s.length&&0===r.length)return V`<div class="banner"><ef-badge tone="ok">All systems normal</ef-badge></div>`;const a=s.slice(0,4),i=s.length-a.length,o=t.critical>0?"banner bad":t.warning>0?"banner warn":"banner";return V`<div class=${o}>${t.critical>0?V`<ef-badge tone="bad">${t.critical} ${Te("critical")}</ef-badge>`:K}${t.warning>0?V`<ef-badge tone="warn">${t.warning} ${Te("warning")}${1===t.warning?"":"s"}</ef-badge>`:K}${a.map(e=>V`<ef-badge tone=${"critical"===e.severity?"bad":"warn"} title=${e.detail}>${e.title} · ${e.device}</ef-badge>`)}${i>0?V`<ef-badge tone="neutral">+${i} more</ef-badge>`:K}${r.map(e=>V`<ef-badge tone="info" title=${e.detail}>${e.title}</ef-badge>`)}</div>`}renderEnergyFlow(e){const t=e.filter(e=>"dpu"===e.projection?.kind&&e.online),s=e.find(e=>"shp2"===e.projection?.kind),r=t.reduce((e,t)=>e+(t.projection.pvTotalWatts??0),0),a=new Set((s?.projection.sources??[]).map(e=>e.sn).filter(e=>!!e)),i=a.size>0?t.filter(e=>a.has(e.sn)):t,o=i.reduce((e,t)=>e+(t.projection.acInWatts??0),0),n=t.reduce((e,t)=>e+(t.projection.acOutWatts??0),0),l=t.reduce((e,t)=>e+(t.projection.totalInWatts??0),0),c=t.reduce((e,t)=>e+(t.projection.totalOutWatts??0),0),d=c-l,h=0===t.length?null:t.reduce((e,t)=>e+(t.projection.soc??0),0)/t.length,p=s?.projection.circuits.reduce((e,t)=>e+(t.watts??0),0)??n,u=o<5,f=90,v=50,g=130,m=60,$=90,b=170,y=130,w=60,x=290,k=95,_=150,S=90,A=510,P=95,E=130,C=90,T=(e,t,s,r)=>{const[a,i]=e,[o,n]=t,l=(a+o)/2,c=`M ${a} ${i} C ${l} ${i}, ${l} ${n}, ${o} ${n}`,d=(e=>e<5?0:Math.max(.6,Math.min(8,1500/Math.max(e,50))))(s),h=(e=>Math.min(8,Math.max(1.5,1.6*Math.log10(Math.max(10,e)))))(s);return q`<g><path d=${c} fill="none" stroke=${r} stroke-opacity=".35" stroke-width=${h} />${d>0?q`<path d=${c} fill="none" stroke=${r} stroke-width=${h} stroke-dasharray="6 10" stroke-linecap="round" style="animation:ef-flowdash ${d}s linear infinite" />`:K}${s>=1?q`<text x=${(a+o)/2} y=${(i+n)/2-11} text-anchor="middle" fill=${r} font-size="12" font-family="ui-monospace,monospace" font-weight="700" stroke="var(--ef-panel)" stroke-width="4" style="paint-order:stroke">${Math.round(s)} W</text>`:K}</g>`},M=(e,t,s,r,a,i,o,n,l,c)=>q`<g><rect x=${e} y=${t} width=${s} height=${r} rx="6" class="flow-bg" stroke=${n} stroke-opacity=".9" stroke-width="1.5" />
<text x=${e+12} y=${t+18} class="flow-label">${a}</text>
<text x=${e+12} y=${t+r-10} class="flow-sub">${i}</text>
<text x=${e+s-12} y=${t+r/2+(c?8:6)} text-anchor="end" fill=${n} font-size=${c?28:18} font-weight="700">${o}</text>
${l?q`<text x=${e+12} y=${t+r/2+8} fill=${n} font-size=${c?26:22}>${l}</text>`:K}</g>`,H=this.socColor(h),j=d>5?`▼ ${_e(d)} discharging`:d<-5?`▲ ${_e(-d)} charging`:"idle";return V`<ef-section .title=${"Energy flow"}>
<ef-badge slot="header" tone=${u?"warn":"ok"}>${u?"off-grid":"grid-tied"}</ef-badge>
<div class="flow-wrap"><svg viewBox="0 0 ${720} ${260}" preserveAspectRatio="xMidYMid meet">${T([f+g,v+m/2],[x,k+S/2],r,"#d97706")}${T([$+y,b+w/2],[x,k+S/2],o,"#586474")}${T([x+_,k+S/2],[A,P+C/2],Math.max(p,n),"#15803d")}${M(f,v,g,m,"Solar","42 panels",_e(r),"#d97706","☀",!1)}${M($,b,y,w,"Grid",u?"islanded":"imported",_e(o),u?"#586474":"#0e7490","⌁",!1)}${M(x,k,_,S,`Batteries (${t.length} DPU)`,j,Se(h,1),H,null,!0)}${M(A,P,E,C,"Loads",`${s?.projection.circuits.filter(e=>(e.watts??0)>1).length??0} circuits`,_e(p),"#15803d","⌂",!1)}</svg></div>
</ef-section>`}renderTopRow(){const e=this.runway.data,t=this.today.data;let s;if(e||this.runway.stale)if(e&&e.unavailable)s=V`<div class="subtitle">${e.unavailable}</div>`;else if(e){const t=e.hoursToReserve??e.hoursToEmpty,r=null!=e.hoursToReserve?"until reserve floor":null!=e.hoursToEmpty?"until empty":`forecast PV keeps up over ${e.horizonHours}h`,a=null==t?"big ok":t<4?"big bad":t<12?"big warn":"big";s=V`<div class="runway-headline">${null!=t?V`<div class=${a}>${t.toFixed(1)}<span class="suffix-h">h</span></div>`:V`<div class=${a}>no dip</div>`}<div class="desc">${r}</div></div>`}else s=V`<div class="subtitle">Off-grid runway unavailable.</div>`;else s=V`<div class="subtitle">Computing off-grid runway…</div>`;const r=(e,t,s,r)=>V`<ef-tile label=${e} value=${null!=t?t.toFixed(s):"—"} unit=${null!=t?r:""}></ef-tile>`,a=[];return e&&(a.push(r("Backup now",e.backupRemainingKwh,1,"kWh")),a.push(r("Reserve floor",e.backupReserveKwh,1,"kWh")),a.push(r("Recent load",e.recentLoadWatts/1e3,2,"kW")),a.push(r(`${e.horizonHours}h forecast PV`,e.forecastPvUsedKwh,1,"kWh"))),t&&(a.push(r("Solar today",t.fleet.pvWh/1e3,1,"kWh")),a.push(r("AC output",t.fleet.acOutWh/1e3,1,"kWh")),a.push(r("Panel load",t.fleet.panelLoadWh/1e3,1,"kWh")),a.push(r("Batteries (net)",t.fleet.batteryNetWh/1e3,1,"kWh"))),V`<ef-section .title=${"Today & runway"}>
${this.runway.stale||this.today.stale?V`<ef-badge slot="header" tone="warn">stale data</ef-badge>`:K}
<div class="full">${s}<div class="top-row">${a}</div></div>
</ef-section>`}renderDeviceGrid(e,t,s){return V`
      <div class="device-grid">
        ${e?this.renderShp2Card(e):K}
        ${t.map(t=>this.renderDpuCard(t,e))}
      </div>
      ${s.length?V`
            <div>
              <div class="others-label">
                Other devices (${s.filter(e=>e.online).length} online ·
                ${s.filter(e=>!e.online).length} offline)
              </div>
              <div class="small-grid">${s.map(e=>this.renderSmallDeviceCard(e))}</div>
            </div>
          `:K}
    `}renderShp2Card(e){const t=e.projection,s=t.backupBatPercent,r=t.backupReserveSoc,a=t.circuits.reduce((e,t)=>e+(t.watts??0),0),i=t.pairedCircuits.filter(e=>(e.watts??0)>1).length,o=[...t.pairedCircuits].filter(e=>(e.watts??0)>1).sort((e,t)=>(t.watts??0)-(e.watts??0)).slice(0,3);return V`<div class="dev">
<div class="dev-head"><div>
<div class="dev-product">${e.productName}</div>
<div class="dev-name">${e.deviceName}</div>
<div class="dev-sn">${e.sn}</div>
</div><ef-badge tone=${e.online?"ok":"bad"}>${e.online?"online":"offline"}</ef-badge></div>
<div><div class="row-flex"><span class="soc-big">${Se(s)}</span><span class="muted-sm">${Te("reserve")} ${Se(r)}</span></div>
<div class="bar bar-mt6"><span style="width:${s??0}%;background:${this.socColor(s)};"></span></div>
</div>
<div class="kv-grid">
<span class="k">${Te("panel load")}</span><span class="v">${_e(a)}</span>
<span class="k">${Te("charge time")}</span><span class="v">${Pe(t.backupChargeTimeMin)}</span>
<span class="k">Capacity</span><span class="v">${(e=>null==e?"—":Math.abs(e)>=1e3?`${(e/1e3).toFixed(2)} kWh`:`${Math.round(e)} Wh`)(t.backupFullCapWh)}</span>
<span class="k">${Te("charge power")}</span><span class="v">${_e(t.chargeWattPower)}</span>
</div>
${o.length?V`<div><div class="section-header">Top circuits · ${i} active</div>
<div class="kv-grid">${o.map(e=>V`<span class="k" title=${e.name}>${e.name}</span><span class="v">${_e(e.watts)}</span>`)}</div></div>`:K}
${t.sources.length?V`<div><div class="section-header">Energy sources (${t.sources.length})</div>
<div class="src-row">${t.sources.map((e,s)=>this.renderShp2Source(e,t.sourceWatts[s]))}</div></div>`:K}
</div>`}renderShp2Source(e,t){return V`<div class="src">
<div class="row-flex"><span class="pct">${Se(e.batteryPercentage)}</span><span>slot ${e.slot}</span></div>
<div class="bar bar-mt4"><span style="width:${e.batteryPercentage??0}%;background:${this.socColor(e.batteryPercentage)};"></span></div>
<div class="bar-mt4">${_e(null!=t?-t:null)} · ${Ae(e.emsBatTemp)}
        </div>
      </div>
    `}renderDpuCard(e,t){const s=e.projection,r=!!s,a=t?.projection.sources.find(t=>t.sn===e.sn),i=s?.soc??a?.batteryPercentage??null,o=null!=s?.soc?1:0,n=s?.remainTimeMin??null,l=s?.packs.length??5;return V`<div class="dev">
<div class="dev-head"><div>
<div class="dev-product">${e.productName}</div>
<div class="dev-name">${e.deviceName}</div>
<div class="dev-sn">${e.sn}</div>
</div>
<div class="col-end">
<div class="row-gap4">${a?V`<ef-badge tone="neutral">SHP2 slot ${a.slot}</ef-badge>`:K}<ef-badge tone=${e.online?"ok":"bad"}>${e.online?"online":"offline"}</ef-badge></div>
${!r&&a?V`<span class="muted-xs">direct down · via SHP2</span>`:K}
</div></div>
<div><div class="row-flex"><span class="soc-big">${Se(i,o)}</span><span class="muted-sm">${null!=n?`${Pe(n)} remain`:"—"}</span></div>
<div class="bar bar-mt6"><span style="width:${i??0}%;background:${this.socColor(i)};"></span></div>
</div>
<div class="kv-grid">
<span class="k">${Te("pv")}</span><span class="v">${_e(s?.pvTotalWatts)}</span>
<span class="k">${Te("ac out")}</span><span class="v">${_e(s?.acOutWatts)}</span>
<span class="k">${Te("ac in")}</span><span class="v">${_e(s?.acInWatts)}</span>
<span class="k">${Te("mppt")} temp</span><span class="v">HV ${Ae(s?.mpptHvTemp)} · LV ${Ae(s?.mpptLvTemp)}</span>
<span class="k">${Te("total in / out")}</span><span class="v">${_e(s?.totalInWatts)} · ${_e(s?.totalOutWatts)}</span>
</div>
<div><div class="section-header">${l} battery packs${r?"":" (needs WiFi)"}</div>
<div class="pack-row">${Array.from({length:l},(e,t)=>{const r=s?.packs[t];return r?V`<div class="pack"><div class="n">Pack ${r.num}</div><div class="v">${Se(r.soc)}</div>
<div class="bar bar-mt2"><span style="width:${r.soc??0}%;background:${this.socColor(r.soc)};"></span></div>
<div class="n" class="bar-mt2">${Ae(r.temp)}</div></div>`:V`<div class="pack empty"><div class="n">Pack ${t+1}</div><div class="v">—</div><div class="n">no data</div></div>`})}</div></div>
</div>`}renderSmallDeviceCard(e){const t=e.projection,s="generic"===t?.kind,r=s?t.soc:null,a=s?t.temp:null,i=s?t.inWatts??t.acInWatts??null:null,o=s?t.outWatts??t.acOutWatts??null:null,n=s?t.pvWatts??null:null;return V`<div class="dev">
<div class="dev-head"><div>
<div class="dev-product">${e.productName}</div>
<div class="dev-name">${e.deviceName}</div>
<div class="dev-sn">${e.sn}</div>
</div><ef-badge tone=${e.online?"ok":"bad"}>${e.online?"online":"offline"}</ef-badge></div>
${!t&&e.online?V`<ef-badge tone="neutral">app-only device</ef-badge>`:K}
${t||e.online||!e.lastError?K:V`<span class="muted-sm" style="color:var(--ef-bad);">err: ${e.lastError}</span>`}
${null!=r?V`<div><div class="row-flex"><span class="soc-big soc-sm">${Se(r)}</span><span class="muted-sm">${Ae(a)}</span></div>
<div class="bar bar-mt4"><span style="width:${r}%;background:${this.socColor(r)};"></span></div></div>`:K}
${t?V`<div class="kv-grid"><span class="k">${Te("in")}</span><span class="v">${_e(i)}</span>
<span class="k">${Te("out")}</span><span class="v">${_e(o)}</span>
${null!=n?V`<span class="k">${Te("pv")}</span><span class="v">${_e(n)}</span>`:K}</div>`:K}
</div>`}renderForecast(){const e=this.forecast.data,t=this.forecast.stale;if(!e)return V`<ef-section .title=${"24-hour forecast"}>${t?V`<ef-badge slot="header" tone="warn">stale</ef-badge>`:K}<div class="subtitle">${t?"Forecast unavailable.":"Loading forecast…"}</div></ef-section>`;if(!(e.hours.length>0&&e.historyDays>0))return V`<ef-section .title=${"24-hour forecast"}><ef-badge slot="header" tone=${e.hasWeather?"ok":"neutral"}>${e.hasWeather?"cloud-aware":"history only"}</ef-badge><div class="subtitle">Building forecast — needs a little recorded history first.</div></ef-section>`;const s=e.hours.map(e=>({ts:e.ts,value:e.forecastPvW})),r=e.hours.map(e=>({ts:e.ts,value:e.forecastLoadW})),a=e.hours.map(e=>({ts:e.ts,value:e.projectedSocPct})),i=null==e.minProjectedSoc?"Comfortable":e.minProjectedSoc<e.reserveSoc?"Tight":e.minProjectedSoc<e.reserveSoc+15?"Watch":"Comfortable",o="Tight"===i?"bad":"Watch"===i?"warn":"ok";return V`<ef-section .title=${"24-hour forecast"}>
<ef-badge slot="header" tone=${e.hasWeather?"ok":"neutral"}>${e.hasWeather?"cloud-aware":"history only"}</ef-badge>
${t?V`<ef-badge slot="header" tone="warn">stale</ef-badge>`:K}
<div class="full">
<div class="top-row mb8">
<ef-tile label="Solar next 24h" value=${(e.forecastPvWhNext24/1e3).toFixed(1)} unit="kWh"></ef-tile>
<ef-tile label="Projected low SoC" value=${null!=e.minProjectedSoc?Se(e.minProjectedSoc,0):"—"} unit=""></ef-tile>
<ef-tile label="Reserve floor" value=${Se(e.reserveSoc,0)} unit=""></ef-tile>
<ef-tile label="Outlook" value=${i} unit=""><ef-badge tone=${o}>${i}</ef-badge></ef-tile>
</div>
${je({area:{points:s,color:"#d97706",label:"Forecast PV"},line:{points:r,color:"#0e7490",label:"Forecast load"},rightLine:{points:a,color:"#15803d",label:"Projected SoC %"},rightRef:{value:e.reserveSoc,color:"#b91c1c"}},{height:220})}
</div></ef-section>`}},e.EcoflowFleetCard.styles=[ye,n`:host{display:block}ha-card{padding:12px;display:flex;flex-direction:column;gap:12px}@keyframes ef-flowdash{to{stroke-dashoffset:-32}}.muted-sm{font-size:.72rem;color:var(--ef-muted)}.muted-xs{font-size:.65rem;color:var(--ef-muted)}.bar-mt6{margin-top:6px}.bar-mt4{margin-top:4px}.bar-mt2{margin-top:2px}.col-end{display:flex;flex-direction:column;gap:4px;align-items:flex-end}.row-gap4{display:flex;gap:4px}.full{width:100%}.mb8{margin-bottom:8px}.soc-sm{font-size:1.2rem}.suffix-h{font-size:1.1rem;font-weight:600;margin-left:2px}.header{display:flex;align-items:center;justify-content:space-between;gap:8px}.title{font-size:1.1rem;font-weight:600;color:var(--ef-ink)}.subtitle{font-size:.75rem;color:var(--ef-muted);margin-top:2px}.badges{display:flex;align-items:center;gap:6px}.skeleton{padding:20px;text-align:center;color:var(--ef-muted);font-size:.85rem}.skeleton .dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--ef-accent);margin-right:6px;animation:ef-pulse 1.2s ease-in-out infinite}@keyframes ef-pulse{0%,100%{opacity:.3}50%{opacity:1}}.banner{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:8px 10px;border-radius:8px;background:var(--ef-panel);border:1px solid var(--ef-line)}.banner.bad{background:color-mix(in srgb,var(--ef-bad) 8%,var(--ef-panel));border-color:color-mix(in srgb,var(--ef-bad) 40%,var(--ef-line))}.banner.warn{background:color-mix(in srgb,var(--ef-warn) 8%,var(--ef-panel));border-color:color-mix(in srgb,var(--ef-warn) 40%,var(--ef-line))}.flow-wrap{width:100%}.flow-wrap svg{width:100%;max-height:280px;display:block}.flow-bg{fill:color-mix(in srgb,var(--ef-panel) 60%,transparent)}.flow-label{fill:var(--ef-muted);font-size:10px;font-family:ui-sans-serif;letter-spacing:.1em;text-transform:uppercase}.flow-sub{fill:var(--ef-muted);font-size:10px;font-family:ui-sans-serif}.top-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px}.runway-headline{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin-bottom:6px}.runway-headline .big{font-size:1.8rem;font-weight:700;font-variant-numeric:tabular-nums;color:var(--ef-ink)}.runway-headline .big.bad{color:var(--ef-bad)}.runway-headline .big.warn{color:var(--ef-warn)}.runway-headline .big.ok{color:var(--ef-ok)}.runway-headline .desc{font-size:.8rem;color:var(--ef-muted)}.device-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}.dev{border:1px solid var(--ef-line);border-radius:10px;background:var(--ef-panel);padding:10px 12px;display:flex;flex-direction:column;gap:6px}.dev-head{display:flex;justify-content:space-between;align-items:flex-start;gap:6px}.dev-name{font-weight:600;color:var(--ef-ink);font-size:.95rem;line-height:1.2}.dev-product,.section-header,.others-label{font-size:.7rem;color:var(--ef-muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:0}.dev-product{letter-spacing:.04em}.dev-sn{font-family:ui-monospace,Menlo,monospace;font-size:.65rem;color:var(--ef-muted);opacity:.8}.soc-big{font-size:1.6rem;font-weight:700;font-variant-numeric:tabular-nums;color:var(--ef-ink)}.bar{position:relative;height:6px;border-radius:3px;background:color-mix(in srgb,var(--ef-line) 80%,transparent);overflow:hidden}.bar>span{display:block;height:100%;border-radius:3px}.kv-grid{display:grid;grid-template-columns:1fr 1fr;gap:2px 10px;font-size:.8rem;color:var(--ef-ink)}.kv-grid .k{color:var(--ef-muted)}.kv-grid .v{text-align:right;font-variant-numeric:tabular-nums}.pack-row{display:grid;grid-template-columns:repeat(5,1fr);gap:4px}.pack{border:1px solid var(--ef-line);border-radius:6px;padding:4px;text-align:center;font-size:.7rem;background:color-mix(in srgb,var(--ef-panel) 80%,transparent)}.pack.empty{opacity:.5}.pack .n{color:var(--ef-muted)}.pack .v{font-weight:600;font-size:.85rem;color:var(--ef-ink);font-variant-numeric:tabular-nums}.section-header{margin-bottom:4px}.src-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:4px}.src{border:1px solid var(--ef-line);border-radius:6px;padding:4px 6px;font-size:.72rem;color:var(--ef-muted)}.src .pct{font-weight:600;font-size:1rem;color:var(--ef-ink);font-variant-numeric:tabular-nums}.row-flex{display:flex;justify-content:space-between;align-items:baseline;gap:4px}.others-label{margin-bottom:6px}.small-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px}`],t([ve()],e.EcoflowFleetCard.prototype,"runway",void 0),t([ve()],e.EcoflowFleetCard.prototype,"today",void 0),t([ve()],e.EcoflowFleetCard.prototype,"forecast",void 0),e.EcoflowFleetCard=t([(e=>(t,s)=>{void 0!==s?s.addInitializer(()=>{customElements.define(e,t)}):customElements.define(e,t)})("ecoflow-fleet-card")],e.EcoflowFleetCard);const Re=window;return Re.customCards=Re.customCards||[],Re.customCards.some(e=>"ecoflow-fleet-card"===e.type)||Re.customCards.push({type:"ecoflow-fleet-card",name:"EcoFlow Fleet Card",description:"Top-level dashboard for EcoFlow off-grid system"}),e}({});
//# sourceMappingURL=ecoflow-fleet-card.js.map
