var EcoflowInsightsCard=function(e){"use strict";function t(e,t,s,i){var r,a=arguments.length,n=a<3?t:null===i?i=Object.getOwnPropertyDescriptor(t,s):i;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)n=Reflect.decorate(e,t,s,i);else for(var o=e.length-1;o>=0;o--)(r=e[o])&&(n=(a<3?r(n):a>3?r(t,s,n):r(t,s))||n);return a>3&&n&&Object.defineProperty(t,s,n),n}"function"==typeof SuppressedError&&SuppressedError;
/**
     * @license
     * Copyright 2019 Google LLC
     * SPDX-License-Identifier: BSD-3-Clause
     */
const s=globalThis,i=s.ShadowRoot&&(void 0===s.ShadyCSS||s.ShadyCSS.nativeShadow)&&"adoptedStyleSheets"in Document.prototype&&"replace"in CSSStyleSheet.prototype,r=Symbol(),a=new WeakMap;let n=class{constructor(e,t,s){if(this._$cssResult$=!0,s!==r)throw Error("CSSResult is not constructable. Use `unsafeCSS` or `css` instead.");this.cssText=e,this.t=t}get styleSheet(){let e=this.o;const t=this.t;if(i&&void 0===e){const s=void 0!==t&&1===t.length;s&&(e=a.get(t)),void 0===e&&((this.o=e=new CSSStyleSheet).replaceSync(this.cssText),s&&a.set(t,e))}return e}toString(){return this.cssText}};const o=(e,...t)=>{const s=1===e.length?e[0]:t.reduce((t,s,i)=>t+(e=>{if(!0===e._$cssResult$)return e.cssText;if("number"==typeof e)return e;throw Error("Value passed to 'css' function must be a 'css' function result: "+e+". Use 'unsafeCSS' to pass non-literal values, but take care to ensure page security.")})(s)+e[i+1],e[0]);return new n(s,e,r)},l=i?e=>e:e=>e instanceof CSSStyleSheet?(e=>{let t="";for(const s of e.cssRules)t+=s.cssText;return(e=>new n("string"==typeof e?e:e+"",void 0,r))(t)})(e):e,{is:c,defineProperty:d,getOwnPropertyDescriptor:h,getOwnPropertyNames:p,getOwnPropertySymbols:u,getPrototypeOf:f}=Object,m=globalThis,g=m.trustedTypes,v=g?g.emptyScript:"",b=m.reactiveElementPolyfillSupport,w=(e,t)=>e,$={toAttribute(e,t){switch(t){case Boolean:e=e?v:null;break;case Object:case Array:e=null==e?e:JSON.stringify(e)}return e},fromAttribute(e,t){let s=e;switch(t){case Boolean:s=null!==e;break;case Number:s=null===e?null:Number(e);break;case Object:case Array:try{s=JSON.parse(e)}catch(e){s=null}}return s}},y=(e,t)=>!c(e,t),x={attribute:!0,type:String,converter:$,reflect:!1,useDefault:!1,hasChanged:y};
/**
     * @license
     * Copyright 2017 Google LLC
     * SPDX-License-Identifier: BSD-3-Clause
     */Symbol.metadata??=Symbol("metadata"),m.litPropertyMetadata??=new WeakMap;let _=class extends HTMLElement{static addInitializer(e){this._$Ei(),(this.l??=[]).push(e)}static get observedAttributes(){return this.finalize(),this._$Eh&&[...this._$Eh.keys()]}static createProperty(e,t=x){if(t.state&&(t.attribute=!1),this._$Ei(),this.prototype.hasOwnProperty(e)&&((t=Object.create(t)).wrapped=!0),this.elementProperties.set(e,t),!t.noAccessor){const s=Symbol(),i=this.getPropertyDescriptor(e,s,t);void 0!==i&&d(this.prototype,e,i)}}static getPropertyDescriptor(e,t,s){const{get:i,set:r}=h(this.prototype,e)??{get(){return this[t]},set(e){this[t]=e}};return{get:i,set(t){const a=i?.call(this);r?.call(this,t),this.requestUpdate(e,a,s)},configurable:!0,enumerable:!0}}static getPropertyOptions(e){return this.elementProperties.get(e)??x}static _$Ei(){if(this.hasOwnProperty(w("elementProperties")))return;const e=f(this);e.finalize(),void 0!==e.l&&(this.l=[...e.l]),this.elementProperties=new Map(e.elementProperties)}static finalize(){if(this.hasOwnProperty(w("finalized")))return;if(this.finalized=!0,this._$Ei(),this.hasOwnProperty(w("properties"))){const e=this.properties,t=[...p(e),...u(e)];for(const s of t)this.createProperty(s,e[s])}const e=this[Symbol.metadata];if(null!==e){const t=litPropertyMetadata.get(e);if(void 0!==t)for(const[e,s]of t)this.elementProperties.set(e,s)}this._$Eh=new Map;for(const[e,t]of this.elementProperties){const s=this._$Eu(e,t);void 0!==s&&this._$Eh.set(s,e)}this.elementStyles=this.finalizeStyles(this.styles)}static finalizeStyles(e){const t=[];if(Array.isArray(e)){const s=new Set(e.flat(1/0).reverse());for(const e of s)t.unshift(l(e))}else void 0!==e&&t.push(l(e));return t}static _$Eu(e,t){const s=t.attribute;return!1===s?void 0:"string"==typeof s?s:"string"==typeof e?e.toLowerCase():void 0}constructor(){super(),this._$Ep=void 0,this.isUpdatePending=!1,this.hasUpdated=!1,this._$Em=null,this._$Ev()}_$Ev(){this._$ES=new Promise(e=>this.enableUpdating=e),this._$AL=new Map,this._$E_(),this.requestUpdate(),this.constructor.l?.forEach(e=>e(this))}addController(e){(this._$EO??=new Set).add(e),void 0!==this.renderRoot&&this.isConnected&&e.hostConnected?.()}removeController(e){this._$EO?.delete(e)}_$E_(){const e=new Map,t=this.constructor.elementProperties;for(const s of t.keys())this.hasOwnProperty(s)&&(e.set(s,this[s]),delete this[s]);e.size>0&&(this._$Ep=e)}createRenderRoot(){const e=this.shadowRoot??this.attachShadow(this.constructor.shadowRootOptions);return((e,t)=>{if(i)e.adoptedStyleSheets=t.map(e=>e instanceof CSSStyleSheet?e:e.styleSheet);else for(const i of t){const t=document.createElement("style"),r=s.litNonce;void 0!==r&&t.setAttribute("nonce",r),t.textContent=i.cssText,e.appendChild(t)}})(e,this.constructor.elementStyles),e}connectedCallback(){this.renderRoot??=this.createRenderRoot(),this.enableUpdating(!0),this._$EO?.forEach(e=>e.hostConnected?.())}enableUpdating(e){}disconnectedCallback(){this._$EO?.forEach(e=>e.hostDisconnected?.())}attributeChangedCallback(e,t,s){this._$AK(e,s)}_$ET(e,t){const s=this.constructor.elementProperties.get(e),i=this.constructor._$Eu(e,s);if(void 0!==i&&!0===s.reflect){const r=(void 0!==s.converter?.toAttribute?s.converter:$).toAttribute(t,s.type);this._$Em=e,null==r?this.removeAttribute(i):this.setAttribute(i,r),this._$Em=null}}_$AK(e,t){const s=this.constructor,i=s._$Eh.get(e);if(void 0!==i&&this._$Em!==i){const e=s.getPropertyOptions(i),r="function"==typeof e.converter?{fromAttribute:e.converter}:void 0!==e.converter?.fromAttribute?e.converter:$;this._$Em=i;const a=r.fromAttribute(t,e.type);this[i]=a??this._$Ej?.get(i)??a,this._$Em=null}}requestUpdate(e,t,s,i=!1,r){if(void 0!==e){const a=this.constructor;if(!1===i&&(r=this[e]),s??=a.getPropertyOptions(e),!((s.hasChanged??y)(r,t)||s.useDefault&&s.reflect&&r===this._$Ej?.get(e)&&!this.hasAttribute(a._$Eu(e,s))))return;this.C(e,t,s)}!1===this.isUpdatePending&&(this._$ES=this._$EP())}C(e,t,{useDefault:s,reflect:i,wrapped:r},a){s&&!(this._$Ej??=new Map).has(e)&&(this._$Ej.set(e,a??t??this[e]),!0!==r||void 0!==a)||(this._$AL.has(e)||(this.hasUpdated||s||(t=void 0),this._$AL.set(e,t)),!0===i&&this._$Em!==e&&(this._$Eq??=new Set).add(e))}async _$EP(){this.isUpdatePending=!0;try{await this._$ES}catch(e){Promise.reject(e)}const e=this.scheduleUpdate();return null!=e&&await e,!this.isUpdatePending}scheduleUpdate(){return this.performUpdate()}performUpdate(){if(!this.isUpdatePending)return;if(!this.hasUpdated){if(this.renderRoot??=this.createRenderRoot(),this._$Ep){for(const[e,t]of this._$Ep)this[e]=t;this._$Ep=void 0}const e=this.constructor.elementProperties;if(e.size>0)for(const[t,s]of e){const{wrapped:e}=s,i=this[t];!0!==e||this._$AL.has(t)||void 0===i||this.C(t,void 0,s,i)}}let e=!1;const t=this._$AL;try{e=this.shouldUpdate(t),e?(this.willUpdate(t),this._$EO?.forEach(e=>e.hostUpdate?.()),this.update(t)):this._$EM()}catch(t){throw e=!1,this._$EM(),t}e&&this._$AE(t)}willUpdate(e){}_$AE(e){this._$EO?.forEach(e=>e.hostUpdated?.()),this.hasUpdated||(this.hasUpdated=!0,this.firstUpdated(e)),this.updated(e)}_$EM(){this._$AL=new Map,this.isUpdatePending=!1}get updateComplete(){return this.getUpdateComplete()}getUpdateComplete(){return this._$ES}shouldUpdate(e){return!0}update(e){this._$Eq&&=this._$Eq.forEach(e=>this._$ET(e,this[e])),this._$EM()}updated(e){}firstUpdated(e){}};_.elementStyles=[],_.shadowRootOptions={mode:"open"},_[w("elementProperties")]=new Map,_[w("finalized")]=new Map,b?.({ReactiveElement:_}),(m.reactiveElementVersions??=[]).push("2.1.2");
/**
     * @license
     * Copyright 2017 Google LLC
     * SPDX-License-Identifier: BSD-3-Clause
     */
const k=globalThis,S=e=>e,E=k.trustedTypes,A=E?E.createPolicy("lit-html",{createHTML:e=>e}):void 0,P="$lit$",C=`lit$${Math.random().toFixed(9).slice(2)}$`,T="?"+C,M=`<${T}>`,H=document,N=()=>H.createComment(""),O=e=>null===e||"object"!=typeof e&&"function"!=typeof e,z=Array.isArray,U="[ \t\n\f\r]",W=/<(?:(!--|\/[^a-zA-Z])|(\/?[a-zA-Z][^>\s]*)|(\/?$))/g,I=/-->/g,R=/>/g,D=RegExp(`>|${U}(?:([^\\s"'>=/]+)(${U}*=${U}*(?:[^ \t\n\f\r"'\`<>=]|("|')|))|$)`,"g"),j=/'/g,F=/"/g,L=/^(?:script|style|textarea|title)$/i,q=(e=>(t,...s)=>({_$litType$:e,strings:t,values:s}))(1),B=Symbol.for("lit-noChange"),V=Symbol.for("lit-nothing"),K=new WeakMap,G=H.createTreeWalker(H,129);function J(e,t){if(!z(e)||!e.hasOwnProperty("raw"))throw Error("invalid template strings array");return void 0!==A?A.createHTML(t):t}const Q=(e,t)=>{const s=e.length-1,i=[];let r,a=2===t?"<svg>":3===t?"<math>":"",n=W;for(let t=0;t<s;t++){const s=e[t];let o,l,c=-1,d=0;for(;d<s.length&&(n.lastIndex=d,l=n.exec(s),null!==l);)d=n.lastIndex,n===W?"!--"===l[1]?n=I:void 0!==l[1]?n=R:void 0!==l[2]?(L.test(l[2])&&(r=RegExp("</"+l[2],"g")),n=D):void 0!==l[3]&&(n=D):n===D?">"===l[0]?(n=r??W,c=-1):void 0===l[1]?c=-2:(c=n.lastIndex-l[2].length,o=l[1],n=void 0===l[3]?D:'"'===l[3]?F:j):n===F||n===j?n=D:n===I||n===R?n=W:(n=D,r=void 0);const h=n===D&&e[t+1].startsWith("/>")?" ":"";a+=n===W?s+M:c>=0?(i.push(o),s.slice(0,c)+P+s.slice(c)+C+h):s+C+(-2===c?t:h)}return[J(e,a+(e[s]||"<?>")+(2===t?"</svg>":3===t?"</math>":"")),i]};class Z{constructor({strings:e,_$litType$:t},s){let i;this.parts=[];let r=0,a=0;const n=e.length-1,o=this.parts,[l,c]=Q(e,t);if(this.el=Z.createElement(l,s),G.currentNode=this.el.content,2===t||3===t){const e=this.el.content.firstChild;e.replaceWith(...e.childNodes)}for(;null!==(i=G.nextNode())&&o.length<n;){if(1===i.nodeType){if(i.hasAttributes())for(const e of i.getAttributeNames())if(e.endsWith(P)){const t=c[a++],s=i.getAttribute(e).split(C),n=/([.?@])?(.*)/.exec(t);o.push({type:1,index:r,name:n[2],strings:s,ctor:"."===n[1]?se:"?"===n[1]?ie:"@"===n[1]?re:te}),i.removeAttribute(e)}else e.startsWith(C)&&(o.push({type:6,index:r}),i.removeAttribute(e));if(L.test(i.tagName)){const e=i.textContent.split(C),t=e.length-1;if(t>0){i.textContent=E?E.emptyScript:"";for(let s=0;s<t;s++)i.append(e[s],N()),G.nextNode(),o.push({type:2,index:++r});i.append(e[t],N())}}}else if(8===i.nodeType)if(i.data===T)o.push({type:2,index:r});else{let e=-1;for(;-1!==(e=i.data.indexOf(C,e+1));)o.push({type:7,index:r}),e+=C.length-1}r++}}static createElement(e,t){const s=H.createElement("template");return s.innerHTML=e,s}}function X(e,t,s=e,i){if(t===B)return t;let r=void 0!==i?s._$Co?.[i]:s._$Cl;const a=O(t)?void 0:t._$litDirective$;return r?.constructor!==a&&(r?._$AO?.(!1),void 0===a?r=void 0:(r=new a(e),r._$AT(e,s,i)),void 0!==i?(s._$Co??=[])[i]=r:s._$Cl=r),void 0!==r&&(t=X(e,r._$AS(e,t.values),r,i)),t}class Y{constructor(e,t){this._$AV=[],this._$AN=void 0,this._$AD=e,this._$AM=t}get parentNode(){return this._$AM.parentNode}get _$AU(){return this._$AM._$AU}u(e){const{el:{content:t},parts:s}=this._$AD,i=(e?.creationScope??H).importNode(t,!0);G.currentNode=i;let r=G.nextNode(),a=0,n=0,o=s[0];for(;void 0!==o;){if(a===o.index){let t;2===o.type?t=new ee(r,r.nextSibling,this,e):1===o.type?t=new o.ctor(r,o.name,o.strings,this,e):6===o.type&&(t=new ae(r,this,e)),this._$AV.push(t),o=s[++n]}a!==o?.index&&(r=G.nextNode(),a++)}return G.currentNode=H,i}p(e){let t=0;for(const s of this._$AV)void 0!==s&&(void 0!==s.strings?(s._$AI(e,s,t),t+=s.strings.length-2):s._$AI(e[t])),t++}}class ee{get _$AU(){return this._$AM?._$AU??this._$Cv}constructor(e,t,s,i){this.type=2,this._$AH=V,this._$AN=void 0,this._$AA=e,this._$AB=t,this._$AM=s,this.options=i,this._$Cv=i?.isConnected??!0}get parentNode(){let e=this._$AA.parentNode;const t=this._$AM;return void 0!==t&&11===e?.nodeType&&(e=t.parentNode),e}get startNode(){return this._$AA}get endNode(){return this._$AB}_$AI(e,t=this){e=X(this,e,t),O(e)?e===V||null==e||""===e?(this._$AH!==V&&this._$AR(),this._$AH=V):e!==this._$AH&&e!==B&&this._(e):void 0!==e._$litType$?this.$(e):void 0!==e.nodeType?this.T(e):(e=>z(e)||"function"==typeof e?.[Symbol.iterator])(e)?this.k(e):this._(e)}O(e){return this._$AA.parentNode.insertBefore(e,this._$AB)}T(e){this._$AH!==e&&(this._$AR(),this._$AH=this.O(e))}_(e){this._$AH!==V&&O(this._$AH)?this._$AA.nextSibling.data=e:this.T(H.createTextNode(e)),this._$AH=e}$(e){const{values:t,_$litType$:s}=e,i="number"==typeof s?this._$AC(e):(void 0===s.el&&(s.el=Z.createElement(J(s.h,s.h[0]),this.options)),s);if(this._$AH?._$AD===i)this._$AH.p(t);else{const e=new Y(i,this),s=e.u(this.options);e.p(t),this.T(s),this._$AH=e}}_$AC(e){let t=K.get(e.strings);return void 0===t&&K.set(e.strings,t=new Z(e)),t}k(e){z(this._$AH)||(this._$AH=[],this._$AR());const t=this._$AH;let s,i=0;for(const r of e)i===t.length?t.push(s=new ee(this.O(N()),this.O(N()),this,this.options)):s=t[i],s._$AI(r),i++;i<t.length&&(this._$AR(s&&s._$AB.nextSibling,i),t.length=i)}_$AR(e=this._$AA.nextSibling,t){for(this._$AP?.(!1,!0,t);e!==this._$AB;){const t=S(e).nextSibling;S(e).remove(),e=t}}setConnected(e){void 0===this._$AM&&(this._$Cv=e,this._$AP?.(e))}}class te{get tagName(){return this.element.tagName}get _$AU(){return this._$AM._$AU}constructor(e,t,s,i,r){this.type=1,this._$AH=V,this._$AN=void 0,this.element=e,this.name=t,this._$AM=i,this.options=r,s.length>2||""!==s[0]||""!==s[1]?(this._$AH=Array(s.length-1).fill(new String),this.strings=s):this._$AH=V}_$AI(e,t=this,s,i){const r=this.strings;let a=!1;if(void 0===r)e=X(this,e,t,0),a=!O(e)||e!==this._$AH&&e!==B,a&&(this._$AH=e);else{const i=e;let n,o;for(e=r[0],n=0;n<r.length-1;n++)o=X(this,i[s+n],t,n),o===B&&(o=this._$AH[n]),a||=!O(o)||o!==this._$AH[n],o===V?e=V:e!==V&&(e+=(o??"")+r[n+1]),this._$AH[n]=o}a&&!i&&this.j(e)}j(e){e===V?this.element.removeAttribute(this.name):this.element.setAttribute(this.name,e??"")}}class se extends te{constructor(){super(...arguments),this.type=3}j(e){this.element[this.name]=e===V?void 0:e}}class ie extends te{constructor(){super(...arguments),this.type=4}j(e){this.element.toggleAttribute(this.name,!!e&&e!==V)}}class re extends te{constructor(e,t,s,i,r){super(e,t,s,i,r),this.type=5}_$AI(e,t=this){if((e=X(this,e,t,0)??V)===B)return;const s=this._$AH,i=e===V&&s!==V||e.capture!==s.capture||e.once!==s.once||e.passive!==s.passive,r=e!==V&&(s===V||i);i&&this.element.removeEventListener(this.name,this,s),r&&this.element.addEventListener(this.name,this,e),this._$AH=e}handleEvent(e){"function"==typeof this._$AH?this._$AH.call(this.options?.host??this.element,e):this._$AH.handleEvent(e)}}class ae{constructor(e,t,s){this.element=e,this.type=6,this._$AN=void 0,this._$AM=t,this.options=s}get _$AU(){return this._$AM._$AU}_$AI(e){X(this,e)}}const ne=k.litHtmlPolyfillSupport;ne?.(Z,ee),(k.litHtmlVersions??=[]).push("3.3.3");const oe=globalThis;
/**
     * @license
     * Copyright 2017 Google LLC
     * SPDX-License-Identifier: BSD-3-Clause
     */class le extends _{constructor(){super(...arguments),this.renderOptions={host:this},this._$Do=void 0}createRenderRoot(){const e=super.createRenderRoot();return this.renderOptions.renderBefore??=e.firstChild,e}update(e){const t=this.render();this.hasUpdated||(this.renderOptions.isConnected=this.isConnected),super.update(e),this._$Do=((e,t,s)=>{const i=s?.renderBefore??t;let r=i._$litPart$;if(void 0===r){const e=s?.renderBefore??null;i._$litPart$=r=new ee(t.insertBefore(N(),e),e,void 0,s??{})}return r._$AI(e),r})(t,this.renderRoot,this.renderOptions)}connectedCallback(){super.connectedCallback(),this._$Do?.setConnected(!0)}disconnectedCallback(){super.disconnectedCallback(),this._$Do?.setConnected(!1)}render(){return B}}le._$litElement$=!0,le.finalized=!0,oe.litElementHydrateSupport?.({LitElement:le});const ce=oe.litElementPolyfillSupport;ce?.({LitElement:le}),(oe.litElementVersions??=[]).push("4.2.2");
/**
     * @license
     * Copyright 2017 Google LLC
     * SPDX-License-Identifier: BSD-3-Clause
     */
const de={attribute:!0,type:String,converter:$,reflect:!1,hasChanged:y},he=(e=de,t,s)=>{const{kind:i,metadata:r}=s;let a=globalThis.litPropertyMetadata.get(r);if(void 0===a&&globalThis.litPropertyMetadata.set(r,a=new Map),"setter"===i&&((e=Object.create(e)).wrapped=!0),a.set(s.name,e),"accessor"===i){const{name:i}=s;return{set(s){const r=t.get.call(this);t.set.call(this,s),this.requestUpdate(i,r,e,!0,s)},init(t){return void 0!==t&&this.C(i,void 0,e,t),t}}}if("setter"===i){const{name:i}=s;return function(s){const r=this[i];t.call(this,s),this.requestUpdate(i,r,e,!0,s)}}throw Error("Unsupported decorator location: "+i)};
/**
     * @license
     * Copyright 2017 Google LLC
     * SPDX-License-Identifier: BSD-3-Clause
     */function pe(e){return(t,s)=>"object"==typeof s?he(e,t,s):((e,t,s)=>{const i=t.hasOwnProperty(s);return t.constructor.createProperty(s,e),i?Object.getOwnPropertyDescriptor(t,s):void 0})(e,t,s)}
/**
     * @license
     * Copyright 2017 Google LLC
     * SPDX-License-Identifier: BSD-3-Clause
     */function ue(e){return pe({...e,state:!0,attribute:!1})}const fe=new Map,me=[1e3,2e3,4e3,8e3,16e3,3e4];function ge(e,t={}){const s=t.wsCtor??("undefined"!=typeof WebSocket?WebSocket:void 0),i=t.fetchImpl??("undefined"!=typeof fetch?fetch:void 0);let r=null,a="idle",n=null,o=0,l=null,c=null,d=!1,h=!1;const p=new Set,u=()=>{for(const e of p)try{e(r)}catch(e){"undefined"!=typeof console&&console.warn("[ecoflow] snapshot subscriber threw",e)}},f=e=>{a!==e&&(a=e,u())},m=()=>{null!=l&&(clearTimeout(l),l=null)},g=()=>{null!=c&&(clearTimeout(c),c=null)},v=()=>{if(m(),n){n.onopen=null,n.onmessage=null,n.onerror=null,n.onclose=null;try{n.close()}catch{}n=null}},b=()=>{if(d||!s)return;let t;m(),f("idle"===a?"connecting":"reconnecting");try{t=new s(function(e){let t=e.trim().replace(/\/$/,"");return/^https?:\/\//i.test(t)?t=t.replace(/^http/i,"ws"):/^wss?:\/\//i.test(t)||(t=`ws://${t}`),`${t}/ws`}(e))}catch{return void w()}n=t,t.onopen=()=>{d||n!==t||(o=0,f("open"),(()=>{if(h||!i)return;h=!0;const t=function(e,t){let s=e.trim().replace(/\/$/,"");return/^wss?:\/\//i.test(s)?s=s.replace(/^ws/i,"http"):/^https?:\/\//i.test(s)||(s=`http://${s}`),`${s}${t.startsWith("/")?t:`/${t}`}`}(e,"/api/snapshot");i(t).then(e=>e.ok?e.json():null).then(e=>{!d&&e&&null==r&&(r=e,u())}).catch(()=>{})})())},t.onmessage=e=>{if(!d&&n===t)try{const t=JSON.parse("string"==typeof e.data?e.data:"");t&&"snapshot"===t.type&&t.data&&(r=t.data,u())}catch{}},t.onerror=()=>{},t.onclose=()=>{n===t&&(n=null,d?f("closed"):w())}},w=()=>{if(d)return;f("reconnecting");const e=Math.min(o,me.length-1);o+=1,l=setTimeout(()=>{l=null,b()},me[e])},$={getSnapshot:()=>r,connectionState:()=>a,subscribe(t){g(),p.add(t);try{t(r)}catch(e){"undefined"!=typeof console&&console.warn("[ecoflow] snapshot subscriber threw",e)}return 1===p.size&&null==n&&"open"!==a&&"connecting"!==a&&"reconnecting"!==a&&b(),()=>{p.delete(t)&&0===p.size&&(g(),c=setTimeout(()=>{c=null,0===p.size&&(v(),o=0,h=!1,f("idle"),fe.get(e)===$&&fe.delete(e))},5e3))}},_destroy(){d=!0,g(),v(),f("closed"),p.clear(),fe.get(e)===$&&fe.delete(e)}};return $}class ve extends le{constructor(){super(...arguments),this.snapshot=null,this.connState="idle",this._unsubscribe=null,this._stateTimer=null}setConfig(e){if(!e)throw new Error("Invalid config");this.config={host:e.host||"http://homeassistant.local:8787",title:e.title||"EcoFlow Panel",refresh_seconds:e.refresh_seconds??30,type:e.type}}effectiveHost(){return this.config?.host||"http://homeassistant.local:8787"}connectedCallback(){super.connectedCallback();const e=function(e){const t=fe.get(e);if(t)return t;const s=ge(e);return fe.set(e,s),s}(this.effectiveHost());this.connState=e.connectionState(),this._unsubscribe=e.subscribe(t=>{this.snapshot=t,this.connState=e.connectionState()})}disconnectedCallback(){super.disconnectedCallback(),this._unsubscribe&&this._unsubscribe(),this._unsubscribe=null,this._stateTimer&&(clearInterval(this._stateTimer),this._stateTimer=null)}getCardSize(){return 6}}t([pe({attribute:!1})],ve.prototype,"config",void 0),t([ue()],ve.prototype,"snapshot",void 0),t([ue()],ve.prototype,"connState",void 0);const be=o`
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
`,we={};function $e(e,t){for(const s of e.split("|"))we[s.trim()]=t}function ye(e){const t=function(e){const t=function(e){return e.split("·")[0].split("(")[0].replace(/\s+/g," ").trim().toLowerCase()}(e);return t?we[t]:void 0}(e);return t?q`<span class="ef-glossary"
    >${e}<span class="ef-tooltip" role="tooltip">${t}</span></span
  >`:e}function xe(e,t,s,i){const r=t-e||1,a=i-s;return t=>s+(t-e)/r*a}function _e(e,t={}){const s=t.width??320,i=t.height??40,r=t.color??"var(--ef-accent)",a=e.map(e=>e.value).filter(e=>null!=e&&Number.isFinite(e));if(a.length<2)return q`<div style="height:${i}px;color:var(--ef-muted);font-size:10px;">collecting…</div>`;const n=Math.min(...a),o=Math.max(...a),l=.05*(o-n)||1,c=t.yMin??n-l,d=t.yMax??o+l,h=function(e,t,s){const i=[];let r=!1;for(const a of e){if(null==a.value||!Number.isFinite(a.value)){r=!1;continue}const e=t(a.ts),n=s(a.value);i.push(`${r?"L":"M"} ${e.toFixed(1)} ${n.toFixed(1)}`),r=!0}return i.join(" ")}(e,xe(e[0].ts,e[e.length-1].ts,2,s-2),xe(c,d,i-2,2));return q`
    <svg viewBox="0 0 ${s} ${i}" width="100%" height="${i}" preserveAspectRatio="none" aria-hidden="true">
      <path d=${h} fill="none" stroke=${r} stroke-width="1.5" />
    </svg>
  `}$e("soc|state of charge","State of charge — how full the battery is right now, 0–100%."),$e("avg soc","Average state of charge across every online battery pack in the fleet."),$e("soh|state of health|avg soh","State of health — measured usable capacity vs the pack’s original design capacity. A wear gauge; 100% = like-new."),$e("ocv|open-circuit","Open-circuit voltage — the pack’s resting voltage with no load applied."),$e("cell spread|worst cell spread|cell imbalance|cell spread now","Cell-voltage spread — the gap between the highest and lowest cell in a pack. A widening gap is an early sign of imbalance."),$e("cell mean","Average voltage across all of the pack’s cells."),$e("pack volt","Pack terminal voltage."),$e("rep temp","Representative pack temperature reported by the BMS."),$e("cell max|cell min","Hottest / coldest individual cell temperature in the pack."),$e("cell temperatures","Per-cell temperature sensors inside the pack."),$e("cell voltages","Per-cell voltage, each shown with its deviation from the pack mean."),$e("mos max|mosfet temperatures|mosfet temps|mosfet","Power-MOSFET temperature — the BMS switching transistors."),$e("board","BMS circuit-board temperature."),$e("shunt","Current-shunt temperature — the precision resistor the BMS measures pack current across."),$e("ptc heater temperatures|ptc heater temps|ptc","PTC heater temperature — keeps the cells warm enough to charge safely in the cold."),$e("cycles","Equivalent full charge/discharge cycles the pack has completed — a measure of battery age."),$e("lifetime throughput","Total energy ever charged into and discharged out of the pack."),$e("capacity","Energy the battery can store, in kWh."),$e("balancing|cells balancing","The BMS is equalizing cell voltages — routine housekeeping, no action needed."),$e("hottest pack","The warmest pack across the fleet right now."),$e("vitals","The pack’s key live readings at a glance."),$e("pv|pv in|pv total|photovoltaic","Photovoltaic — solar-panel power."),$e("pv high mppt|pv low mppt","Power from one of the DPU’s two solar strings (high- or low-voltage MPPT input)."),$e("ac out|ac output","AC power flowing out of the inverter to your loads."),$e("ac in","AC power flowing into the inverter — grid or generator charging."),$e("ac out freq / v","Inverter AC output frequency (Hz) and voltage."),$e("total in / out","Total power into and out of the DPU across every input and output."),$e("battery v / a","Internal battery-bus voltage and current."),$e("in|out","Power flowing in to / out of the device."),$e("input|output","Power flowing into (charging) or out of (discharging) the pack."),$e("panel load","Total power the SHP2’s circuits are drawing right now."),$e("live contribution|live draw","Power this device is feeding/drawing right now."),$e("voltage|current","Live electrical voltage / current at this input."),$e("v × a","Voltage × current — instantaneous power, shown as a cross-check on the reported watts."),$e("string ω","Effective resistance (volts ÷ amps) at the MPPT string’s operating point."),$e("mppt|mppt temp|mppt hv|mppt lv|hv mppt|lv mppt","MPPT — the solar charge controller (Maximum Power Point Tracker). Each DPU has two: a high-voltage and a low-voltage string input."),$e("hv channels|lv channels","High-/low-voltage MPPT solar string inputs — one of each per DPU."),$e("ghi","Global Horizontal Irradiance — total sunlight energy on a flat surface (W/m²); the raw “how sunny” number the forecast is built from."),$e("producing now","Solar power being generated right now."),$e("peak today","The highest solar power reached so far today."),$e("coefficient|peak response|response coefficient","Learned response coefficient — watts of PV produced per W/m² of sunlight. Captures panel size, orientation, shading and inverter clipping."),$e("strongest hour","The hour of day your arrays convert sunlight to power most efficiently — reveals their orientation."),$e("observed peak pv","The highest PV output actually recorded at this hour-of-day."),$e("soiling","Dust/pollen on the panels cutting output. Detected by comparing clear-sky production to the cleanest day on record."),$e("output drop","How far clear-sky solar output has fallen below the clean-panel baseline — the soiling indicator."),$e("backup|backup pool","SHP2 backup pool — the combined battery the Smart Home Panel draws on."),$e("backup %","Backup-pool state of charge, trended over the last hour."),$e("reserve floor|backup reserve|reserve","Reserve floor — the state of charge held back for backup. Loads begin shedding below it."),$e("solar reserve","Target state of charge to keep in reserve specifically when running on solar."),$e("mid-priority floor","The SoC at which mid-priority circuits are cut to protect the battery."),$e("charge power","Power currently flowing into the battery."),$e("charge time","Estimated time to fully charge the battery."),$e("rated power","The device’s rated maximum power output."),$e("ems bat temp","Battery temperature as reported by the SHP2’s energy-management system."),$e("hw link","Hardware (wired) link status between the SHP2 and this DPU."),$e("load-shed strategy","The SHP2’s automatic plan for dropping circuits as the battery depletes."),$e("smart backup mode","The SHP2’s backup-behaviour mode setting."),$e("charge schedule","The SHP2’s time-of-use scheduled charging windows."),$e("error code|direct errors|shp2 errors","Device-reported error code — 0 means no fault."),$e("charging power","Power the EV charger is drawing, over the last 24 hours."),$e("sessions today","Charging sessions detected today — a sustained draw above 1 kW."),$e("host dpu|dpu battery","The Delta Pro Ultra the EV charger is wired to — that DPU’s AC output equals the charging draw."),$e("direct telemetry|direct evse telemetry","Raw data straight from the device over MQTT, rather than inferred."),$e("solar next 24 h|solar next 24h","Projected solar production, from the cloud forecast run through your learned array model."),$e("forecast load|forecast load 24 h|typical solar / day","Projected household load from the typical-day consumption curve."),$e("forecast pv","Projected PV output for this hour."),$e("projected low soc","The lowest the battery is forecast to reach over the next 24 hours."),$e("cloud cover","Forecast cloud cover — what derates the solar prediction each hour."),$e("outlook","At-a-glance battery comfort vs the reserve floor: Comfortable, Watch or Tight."),$e("history depth","Days of recorded data behind the forecast and learned models — they sharpen as it grows."),$e("confidence","How trustworthy the learned model is, based on how many samples it has."),$e("z-score|peer z-score","Modified z-score — how many robust deviations a reading sits from normal. Higher = more anomalous; ≥ 3.5 flags, ≥ 5 warns."),$e("fit quality|fit r²","R-squared — how well the trend line fits the data, 0–1. Higher means a more trustworthy projection."),$e("samples|regression samples","How many data points the estimate is built from — more points, more reliable."),$e("sibling median","The median reading across the pack’s four siblings — the “normal” this pack is compared against."),$e("this pack","This pack’s current reading."),$e("deviation","How far this reading sits from the expected/normal value."),$e("baseline window","The span of history and number of samples behind the self-baseline."),$e("decline rate|rise rate","How fast the value is changing, per unit time."),$e("end-of-life|eol|projected eol|reaches 80%","End of life — the 80%-SoH point where a pack has lost a fifth of its original capacity; the conventional LFP replacement mark."),$e("fade rate|fade / yr|avg fade rate","How fast measured capacity (State of Health) is falling — SoH percentage points lost per year."),$e("service left|years left|years to eol","Projected years of service remaining before the pack reaches the 80% end-of-life threshold."),$e("eol threshold","The State of Health at which a pack counts as end-of-life — conventionally 80% for LFP cells."),$e("packs projecting","How many packs have a firm enough SoH trend to project an end-of-life date."),$e("soonest eol","The pack across the fleet projected to reach end-of-life first."),$e("cycles at eol","Projected equivalent full-cycle count by the time the pack reaches end-of-life."),$e("data span","Days of recorded history the projection is regressed over."),$e("projection notes","Plain-language end-of-life verdict for each pack with a firm fade trend."),$e("trend","Whether a pack has a projected fade trend, is stable, is still learning, or has no data yet."),$e("critical","Critical — an immediate problem that needs attention now."),$e("warnings|warning","Warning — something to investigate soon."),$e("informational|info","Informational — noted for awareness, not urgent."),$e("anomalies","Things unusual right now — flagged by peer comparison and self-baseline."),$e("forecasts","Where things are heading — runtime, degradation and day-ahead projections."),$e("actionable","Critical + warning items that may need attention."),$e("recently cleared","Alerts that were raised and have since resolved, with how long each lasted."),$e("today","Energy totals since local midnight."),$e("solar produced","Total solar energy harvested today."),$e("batteries","Net battery energy today — negative means net charged, positive means net discharged.");class ke extends le{constructor(){super(...arguments),this.tone="neutral"}render(){return q`<slot></slot>`}}ke.styles=[be,o`
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
    `],t([pe({reflect:!0})],ke.prototype,"tone",void 0),customElements.get("ef-badge")||customElements.define("ef-badge",ke);class Se extends le{constructor(){super(...arguments),this.label="",this.value="",this.unit=""}render(){return q`
      <div class="label"><slot name="label">${this.label}</slot></div>
      <div class="value-line">
        <span class="value"><slot name="value">${this.value}</slot></span>
        ${this.unit?q`<span class="unit">${this.unit}</span>`:null}
      </div>
      <slot></slot>
    `}}Se.styles=[be,o`
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
    `],t([pe()],Se.prototype,"label",void 0),t([pe()],Se.prototype,"value",void 0),t([pe()],Se.prototype,"unit",void 0),customElements.get("ef-tile")||customElements.define("ef-tile",Se);class Ee extends le{constructor(){super(...arguments),this.title=""}render(){return q`
      <header>
        <div class="title"><slot name="title">${this.title}</slot></div>
        <div class="header-extra"><slot name="header"></slot></div>
      </header>
      <div class="body"><slot></slot></div>
    `}}Ee.styles=[be,o`
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
    `],t([pe()],Ee.prototype,"title",void 0),customElements.get("ef-section")||customElements.define("ef-section",Ee);const Ae=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"],Pe=["incidents","nws","selfConsumption"];e.EcoflowInsightsCard=class extends ve{constructor(){super(...arguments),this.sc={data:null,stale:!1},this.thermal={data:null,stale:!1},this.equip={data:null,stale:!1},this.shade={data:null,stale:!1},this.soil={data:null,stale:!1},this.mismatch={data:null,stale:!1},this.ev={data:null,stale:!1},this.charge={data:null,stale:!1},this.ir={data:null,stale:!1},this.skill={data:null,stale:!1},this.ambient={data:null,stale:!1},this.conf={data:null,stale:!1},this.nws={data:null,stale:!1},this.incidents={data:null,stale:!1},this.ensemble={data:null,stale:!1},this.expanded=new Set(Pe),this._httpTimer=null}connectedCallback(){super.connectedCallback(),this._kickHttpFetches();const e=Math.max(15,this.config?.refresh_seconds??60);this._httpTimer=setInterval(()=>this._kickHttpFetches(),1e3*e)}disconnectedCallback(){super.disconnectedCallback(),this._httpTimer&&(clearInterval(this._httpTimer),this._httpTimer=null)}_kickHttpFetches(){this._fetchOne("/api/self-consumption",()=>this.sc,e=>this.sc=e),this._fetchOne("/api/thermal-events",()=>this.thermal,e=>this.thermal=e),this._fetchOne("/api/equipment-health",()=>this.equip,e=>this.equip=e),this._fetchOne("/api/shade-report",()=>this.shade,e=>this.shade=e),this._fetchOne("/api/soiling-decomposition",()=>this.soil,e=>this.soil=e),this._fetchOne("/api/string-mismatch",()=>this.mismatch,e=>this.mismatch=e),this._fetchOne("/api/ev-window-prediction",()=>this.ev,e=>this.ev=e),this._fetchOne("/api/charge-curve",()=>this.charge,e=>this.charge=e),this._fetchOne("/api/internal-resistance",()=>this.ir,e=>this.ir=e),this._fetchOne("/api/forecast-skill",()=>this.skill,e=>this.skill=e),this._fetchOne("/api/ambient-thermal-forecast",()=>this.ambient,e=>this.ambient=e),this._fetchOne("/api/confidence",()=>this.conf,e=>this.conf=e),this._fetchListEnvelope("/api/nws-alerts","alerts",()=>this.nws,e=>this.nws=e),this._fetchListEnvelope("/api/incidents","incidents",()=>this.incidents,e=>this.incidents=e),this._fetchEnsemble()}async _fetchOne(e,t,s){try{const t=this.effectiveHost().replace(/\/$/,"")+e,i=await fetch(t);if(!i.ok)throw new Error(`HTTP ${i.status}`);s({data:await i.json(),stale:!1})}catch{s({...t(),stale:!0})}}async _fetchListEnvelope(e,t,s,i){try{const s=this.effectiveHost().replace(/\/$/,"")+e,r=await fetch(s);if(!r.ok)throw new Error(`HTTP ${r.status}`);const a=await r.json();i({data:Array.isArray(a[t])?a[t]:[],stale:!1})}catch{i({...s(),stale:!0})}}async _fetchEnsemble(){try{const e=this.effectiveHost().replace(/\/$/,"")+"/api/weather/ensemble",t=await fetch(e);if(!t.ok)throw new Error(`HTTP ${t.status}`);const s=await t.json();if(s.error)return void(this.ensemble={data:null,stale:!1});this.ensemble={data:{sourcesCount:Number(s.sourcesCount??0),avgDisagreementPct:Number(s.avgDisagreementPct??0),enrichedHourCount:Number(s.enrichedHourCount??0),hourCount:Number(s.hourCount??0)},stale:!1}}catch{this.ensemble={...this.ensemble,stale:!0}}}connTone(e){return"open"===e?"ok":"connecting"===e||"reconnecting"===e?"warn":"closed"===e?"bad":"neutral"}connLabel(e){return"open"===e?"live":"connecting"===e?"linking":"reconnecting"===e?"reconnecting":"closed"===e?"offline":"idle"}toggle(e){const t=new Set(this.expanded);t.has(e)?t.delete(e):t.add(e),this.expanded=t}wrapSection(e,t,s,i,r=!1){const a=this.expanded.has(e);return q`<ef-section>
      <span slot="title">${t}</span>
      ${s}
      ${r?q`<ef-badge slot="header" tone="warn">stale data</ef-badge>`:V}
      <button
        slot="header"
        class="toggle"
        aria-expanded=${a?"true":"false"}
        @click=${()=>this.toggle(e)}
      >
        ${a?"Hide":"Show"}
      </button>
      ${a?i():V}
    </ef-section>`}render(){const e=this.snapshot,t=this.config?.title??"Advanced insights";return null===e?q`<ha-card>
        <div class="header">
          <div>
            <div class="title">${t}</div>
            <div class="subtitle">${this.effectiveHost()}</div>
          </div>
          <div class="badges">
            <ef-badge tone=${this.connTone(this.connState)}
              >${this.connLabel(this.connState)}</ef-badge
            >
          </div>
        </div>
        <div class="skeleton"><span class="dot"></span>Connecting to add-on…</div>
      </ha-card>`:q`<ha-card>
      ${this.renderHeader(t)}
      <div class="blurb">
        The full advanced-analytics surface, one block per family. Quiet sections mean the
        underlying signal has nothing actionable to say right now.
      </div>
      ${this.renderIncidents()}
      ${this.renderNws()}
      ${this.renderSelfConsumption()}
      ${this.renderEnsemble()}
      ${this.renderConfidence()}
      ${this.renderThermal()}
      ${this.renderEquipment()}
      ${this.renderShade()}
      ${this.renderSoiling()}
      ${this.renderMismatch()}
      ${this.renderEv()}
      ${this.renderCharge()}
      ${this.renderIr()}
      ${this.renderSkill()}
      ${this.renderAmbient()}
    </ha-card>`}renderHeader(e){return q`<div class="header">
      <div>
        <div class="title">${e}</div>
        <div class="subtitle">v0.7.5 analytics</div>
      </div>
      <div class="badges">
        <ef-badge tone=${this.connTone(this.connState)}
          >${this.connLabel(this.connState)}</ef-badge
        >
      </div>
    </div>`}renderIncidents(){const e=this.incidents.data??[];return 0!==e.length||this.incidents.stale?this.wrapSection("incidents",ye("Incident"),e.length>0?q`<ef-badge slot="header" tone="bad">${e.length}</ef-badge>`:V,()=>0===e.length?q`<div class="no-data">No active incidents.</div>`:q`<div class="row-list full">
          ${e.slice(0,8).map(e=>q`<div class="incident">
              <div class="title-line">
                <span class="name">${e.title}</span>
                <span class="scope">${e.scope}</span>
              </div>
              <span class="meta">${e.alertCount} alerts</span>
              <div class="detail">${e.detail}</div>
            </div>`)}
        </div>`,this.incidents.stale):V}renderNws(){const e=this.nws.data??[];return 0!==e.length||this.nws.stale?this.wrapSection("nws",ye("NWS storm"),e.length>0?q`<ef-badge slot="header" tone="warn">${e.length}</ef-badge>`:V,()=>0===e.length?q`<div class="no-data">No active NWS alerts.</div>`:q`<div class="row-list full">
          ${e.map(e=>q`<div class="nws-row">
              <div class="event">${e.event}</div>
              <div class="headline">${e.headline??e.areaDesc??""}</div>
              <div class="sev">
                Severity ${e.severity} · ${e.urgency} · expires
                ${e.expires?new Date(e.expires).toLocaleString():"—"}
              </div>
            </div>`)}
        </div>`,this.nws.stale):V}renderSelfConsumption(){const e=this.sc.data;return e||this.sc.stale?this.wrapSection("selfConsumption",ye("Self-consumption"),V,()=>e?q`<div class="tile-grid">
          <ef-tile label="PV gen" value=${e.pvKwh.toFixed(1)} unit="kWh"></ef-tile>
          <ef-tile label="Load" value=${e.loadKwh.toFixed(1)} unit="kWh"></ef-tile>
          <ef-tile
            label="To battery"
            value=${e.pvToBatteryKwh.toFixed(1)}
            unit="kWh"
          ></ef-tile>
          <ef-tile
            label="Bat discharge"
            value=${e.batteryDischargeKwh.toFixed(1)}
            unit="kWh"
          ></ef-tile>
          <ef-tile
            label="Grid import"
            value=${e.gridImportKwh.toFixed(1)}
            unit="kWh"
          ></ef-tile>
          <ef-tile
            label="Solar fraction"
            value=${null!=e.solarFractionOfLoadPct?e.solarFractionOfLoadPct.toString():"—"}
            unit=${null!=e.solarFractionOfLoadPct?"%":""}
          ></ef-tile>
          <ef-tile
            label="Direct use"
            value=${null!=e.directUseRatioPct?e.directUseRatioPct.toString():"—"}
            unit=${null!=e.directUseRatioPct?"%":""}
          ></ef-tile>
        </div>`:q`<div class="no-data">Self-consumption unavailable.</div>`,this.sc.stale):V}renderEnsemble(){const e=this.ensemble.data;return e&&!(e.sourcesCount<=1)||this.ensemble.stale?this.wrapSection("ensemble","Weather ensemble",V,()=>{if(!e||e.sourcesCount<=1)return q`<div class="no-data">Only one source — no ensemble yet.</div>`;const t=Math.round(e.enrichedHourCount/Math.max(1,e.hourCount)*100);return q`<div class="tile-grid">
          <ef-tile label="Sources" value=${e.sourcesCount.toString()}>
            <span>enriched ${e.enrichedHourCount}/${e.hourCount} h</span>
          </ef-tile>
          <ef-tile
            label="Avg disagreement"
            value=${e.avgDisagreementPct.toFixed(1)}
            unit="%"
          >
            <span>|Open-Meteo − NWS|</span>
          </ef-tile>
          <ef-tile
            label="Status"
            value=${e.avgDisagreementPct>15?"wide":"tight"}
          >
            <span>forecast bands</span>
          </ef-tile>
          <ef-tile label="Coverage" value=${t.toString()} unit="%">
            <span>ensemble overlap</span>
          </ef-tile>
        </div>`},this.ensemble.stale):V}renderConfidence(){const e=this.conf.data;return e||this.conf.stale?this.wrapSection("confidence",ye("Confidence"),V,()=>e?q`<div class="tile-grid">
          <ef-tile
            label="Degradation R²"
            value=${null!=e.degradationMedianR2?e.degradationMedianR2.toFixed(2):"—"}
          ></ef-tile>
          <ef-tile
            label="Solar model R²"
            value=${null!=e.solarModelMedianR2?e.solarModelMedianR2.toFixed(2):"—"}
          ></ef-tile>
          <ef-tile
            label="Thermal R²"
            value=${null!=e.thermalMedianR2?e.thermalMedianR2.toFixed(2):"—"}
          ></ef-tile>
          <ef-tile
            label="Forecast bias"
            value=${null!=e.forecastSkillBiasFactor?`×${e.forecastSkillBiasFactor.toFixed(2)}`:"—"}
          ></ef-tile>
          <ef-tile
            label="Forecast MAE"
            value=${null!=e.forecastSkillMaePct?e.forecastSkillMaePct.toString():"—"}
            unit=${null!=e.forecastSkillMaePct?"%":""}
          ></ef-tile>
        </div>`:q`<div class="no-data">Confidence snapshot unavailable.</div>`,this.conf.stale):V}renderThermal(){const e=this.thermal.data;return e&&0!==e.packs.length||this.thermal.stale?this.wrapSection("thermal","Thermal events",V,()=>{if(!e||0===e.packs.length)return q`<div class="no-data">No thermal events recorded.</div>`;const t=[...e.packs].sort((e,t)=>t.hardLifeScore-e.hardLifeScore).slice(0,8);return q`<div class="row-list full">
          ${t.map(e=>q`<div class="row">
              <span class="label">Core ${e.coreNum} · Pk ${e.packNum}</span>
              <span class="meta"
                >${e.warmEvents}w / ${e.hotEvents}h / ${e.overheatEvents}o ·
                ${e.warmHours}h warm</span
              >
              <span class="num right">${e.hardLifeScore.toFixed(0)}</span>
            </div>`)}
        </div>`},this.thermal.stale):V}renderEquipment(){const e=this.equip.data,t=!!e&&(e.mpptStrings.some(e=>null!=e.driftPctPts)||e.inverterStandby.some(e=>null!=e.idleWatts));return t||this.equip.stale?this.wrapSection("equipment","Equipment health",V,()=>{if(!e||!t)return q`<div class="no-data">No equipment-health signal yet.</div>`;const s=e.mpptStrings.filter(e=>null!=e.recentEffPct),i=e.inverterStandby.filter(e=>null!=e.idleWatts);return q`<div class="full">
          ${s.length>0?q`<div class="sub-head">${ye("MPPT")} efficiency</div>
                <div class="row-list">
                  ${s.map(e=>{const t=e.driftPctPts,s=null!=t&&t<-1?"warn":"";return q`<div class="row">
                      <span class="label">Core ${e.coreNum} ${e.string}</span>
                      <span class="num">${e.recentEffPct}% / base ${e.baselineEffPct}%</span>
                      <span class="num ${s} right">
                        ${null!=t?(t>=0?"+":"")+t:""}
                      </span>
                    </div>`})}
                </div>`:V}
          ${i.length>0?q`<div class="sub-head">Inverter standby</div>
                <div class="row-list">
                  ${i.map(e=>q`<div class="row">
                      <span class="label">Core ${e.coreNum}</span>
                      <span class="num"
                        >${e.idleWatts} W idle (base ${e.baselineIdleWatts})</span
                      >
                      <span class="right">
                        ${null!=e.trendWattsPerWeek?`${e.trendWattsPerWeek>=0?"+":""}${e.trendWattsPerWeek} W/wk`:""}
                      </span>
                    </div>`)}
                </div>`:V}
        </div>`},this.equip.stale):V}renderShade(){const e=this.shade.data;return e&&0!==e.hours.length||this.shade.stale?this.wrapSection("shade","Shade events",V,()=>e&&0!==e.hours.length?q`<div class="full">
          <div class="ev-summary">
            Est. ${e.estTotalKwhPerYear} kWh/yr lost to physical obstruction
          </div>
          <div class="hour-strip">
            ${e.hours.map(e=>q`<div class="hour-cell">
                <div class="h">${e.hour}:00</div>
                <div>-${e.shortfallPct}%</div>
                <div class="h">${e.observedW}/${e.expectedW} W</div>
              </div>`)}
          </div>
        </div>`:q`<div class="no-data">No recurring shade detected.</div>`,this.shade.stale):V}renderSoiling(){const e=this.soil.data,t=!!e&&(e.perDevice.length>0||e.perHour.length>0);return t||this.soil.stale?this.wrapSection("soiling","Soiling decomposition",V,()=>e&&t?q`<div class="full">
          ${e.perDevice.length>0?q`<div class="sub-head">Per DPU</div>
                <div class="tile-grid">
                  ${e.perDevice.map(e=>q`<ef-tile
                      label=${`Core ${e.coreNum??e.device}`}
                      value=${null!=e.dropPct?`${e.dropPct}%`:"—"}
                    >
                      <span>${e.cleanDays} clear d</span>
                    </ef-tile>`)}
                </div>`:V}
          ${e.perHour.length>0?q`<div class="sub-head">Per hour</div>
                <div class="hour-strip">
                  ${e.perHour.map(e=>q`<div class="hour-cell ${e.dropPct>=15?"warn":""}">
                      <div class="h">${e.hour}</div>
                      <div>${e.dropPct}%</div>
                    </div>`)}
                </div>`:V}
        </div>`:q`<div class="no-data">No soiling signal — panels look clean.</div>`,this.soil.stale):V}renderMismatch(){const e=this.mismatch.data;return e&&0!==e.devices.length||this.mismatch.stale?this.wrapSection("mismatch","String mismatch",V,()=>e&&0!==e.devices.length?q`<div class="row-list full">
          ${e.devices.map(e=>q`<div class="row" data-tone=${e.outlier?"warn":""}>
              <span class="label">Core ${e.coreNum??e.device}</span>
              <span class="num"
                >${e.recentMedianW} W / fleet ${e.fleetMedianW} W</span
              >
              <span class="num">${null!=e.ratio?`×${e.ratio.toFixed(2)}`:"—"}</span>
              ${e.outlier?q`<ef-badge tone="warn">underperformer</ef-badge>`:V}
            </div>`)}
        </div>`:q`<div class="no-data">No DPU mismatch — fleet is even.</div>`,this.mismatch.stale):V}renderEv(){const e=this.ev.data;return e&&0!==e.patterns.length||this.ev.stale?this.wrapSection("ev","EV-charging windows",V,()=>e&&0!==e.patterns.length?q`<div class="full">
          <div class="ev-summary">
            ${e.sessionsObserved} session${1===e.sessionsObserved?"":"s"} observed in last 30
            d · ${e.upcomingNext24h.length} predicted in next 24 h
          </div>
          <div class="row-list">
            ${e.patterns.slice(0,8).map(e=>q`<div class="row">
                <span class="label"
                  >${Ae[e.dayOfWeek]} @ ${e.startHour}:00</span
                >
                <span class="meta"
                  >~${e.typicalDurationHours} h · ${e.typicalWatts} W · ≈
                  ${e.energyKwh} kWh</span
                >
                <span class="right">observed ${e.recurrences}×</span>
              </div>`)}
          </div>
        </div>`:q`<div class="no-data">No recurring EV charging detected.</div>`,this.ev.stale):V}renderCharge(){const e=this.charge.data,t=!!e&&e.packs.some(e=>null!=e.meanDriftMv);return t||this.charge.stale?this.wrapSection("charge","Charge-curve drift",V,()=>{if(!e||!t)return q`<div class="no-data">No charge-curve drift detected.</div>`;const s=e.packs.filter(e=>null!=e.meanDriftMv).slice(0,10);return q`<div class="row-list full">
          ${s.map(e=>q`<div class="row" style="flex-direction:column;align-items:stretch;">
              <div style="display:flex;align-items:baseline;gap:8px;width:100%;">
                <span class="label">Core ${e.coreNum} · Pack ${e.packNum}</span>
                <span class="right">mean drift ±${e.meanDriftMv} mV</span>
              </div>
              <div class="checkpoint-grid">
                ${e.checkpoints.map(e=>q`<div class="checkpoint">
                    <div class="soc">${e.soc}%</div>
                    <div>
                      ${null!=e.driftMv?`${e.driftMv>=0?"+":""}${e.driftMv}`:"—"}
                    </div>
                  </div>`)}
              </div>
            </div>`)}
        </div>`},this.charge.stale):V}renderIr(){const e=this.ir.data,t=!!e&&e.devices.some(e=>null!=e.recentMilliohms);return t||this.ir.stale?this.wrapSection("ir","Internal resistance",V,()=>{if(!e||!t)return q`<div class="no-data">No internal-resistance signal yet.</div>`;const s=e.devices.filter(e=>null!=e.recentMilliohms);return q`<div class="row-list full">
          ${s.map(e=>{const t=e.trendMilliohmsPerMonth,s=null!=t&&t>.5?"warn":"";return q`<div class="row">
              <span class="label">Core ${e.coreNum}</span>
              <span class="num">${e.recentMilliohms} mΩ</span>
              <span class="meta">base ${e.baselineMilliohms} mΩ</span>
              <span class="num ${s} right">
                ${null!=t?`${t>=0?"+":""}${t} mΩ/mo`:""}
              </span>
            </div>`})}
        </div>`},this.ir.stale):V}renderSkill(){const e=this.skill.data;return e&&0!==e.days.length||this.skill.stale?this.wrapSection("skill",ye("Forecast skill"),V,()=>{if(!e||0===e.days.length)return q`<div class="no-data">Forecast skill needs more days of hindcast.</div>`;const t=e.days.filter(e=>null!=e.errorPct).map(e=>({ts:new Date(e.date).getTime(),value:Math.abs(e.errorPct)}));return q`<div class="full">
          ${null!=e.meanAbsErrorPct?q`<div class="ev-summary">
                MAE ${e.meanAbsErrorKwh} kWh (${e.meanAbsErrorPct}%) · bias factor ×${e.biasFactor?.toFixed(2)??"—"}
              </div>`:V}
          ${t.length>=2?q`<div class="full">
                ${_e(t,{width:320,height:36,color:"var(--ef-warn)"})}
              </div>`:V}
          <div class="tile-grid">
            ${e.days.map(e=>q`<ef-tile
                label=${e.date.slice(5)}
                value=${e.actualKwh.toFixed(1)}
                unit="kWh"
              >
                <span>pred ${e.predictedKwh.toFixed(1)}</span>
              </ef-tile>`)}
          </div>
        </div>`},this.skill.stale):V}renderAmbient(){const e=this.ambient.data,t=!!e&&e.packs.some(e=>null!=e.predictedPeak24hC);return t||this.ambient.stale?this.wrapSection("ambient","Ambient thermal forecast",V,()=>{if(!e||!t)return q`<div class="no-data">No ambient-coupled thermal forecast yet.</div>`;const s=e.packs.filter(e=>null!=e.predictedPeak24hC).slice(0,10);return q`<div class="row-list full">
          ${s.map(e=>{const t=null!=e.predictedPeak24hC?Math.round(1.8*e.predictedPeak24hC+32):null,s=e.predictedPeakAtMs?new Date(e.predictedPeakAtMs).toLocaleString([],{weekday:"short",hour:"numeric"}):"";return q`<div class="row">
              <span class="label">Core ${e.coreNum} · Pk ${e.packNum}</span>
              <span class="num">${t}°F</span>
              <span class="meta">${s}</span>
              <span class="right">R² ${e.r2?.toFixed(2)??"—"}</span>
            </div>`})}
        </div>`},this.ambient.stale):V}getCardSize(){return 10}},e.EcoflowInsightsCard.styles=[be,o`
      :host { display: block; }
      ha-card { padding: 12px; display: flex; flex-direction: column; gap: 12px; }
      .header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
      .title { font-size: 1.1rem; font-weight: 600; color: var(--ef-ink); }
      .subtitle { font-size: 0.75rem; color: var(--ef-muted); margin-top: 2px; }
      .badges { display: flex; align-items: center; gap: 6px; }
      .skeleton { padding: 20px; text-align: center; color: var(--ef-muted); font-size: 0.85rem; }
      .skeleton .dot {
        display: inline-block; width: 8px; height: 8px; border-radius: 50%;
        background: var(--ef-accent); margin-right: 6px;
        animation: ef-pulse 1.2s ease-in-out infinite;
      }
      @keyframes ef-pulse { 0%, 100% { opacity: 0.3; } 50% { opacity: 1; } }
      .blurb { font-size: 0.78rem; color: var(--ef-muted); line-height: 1.4; }
      .full { width: 100%; }
      .tile-grid {
        display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
        gap: 6px; width: 100%;
      }
      .row-list { display: flex; flex-direction: column; gap: 4px; width: 100%; }
      /* Generic two-tone row used for thermal / equipment / IR / charge / etc. */
      .row {
        display: flex; align-items: baseline; gap: 8px; padding: 4px 8px;
        border: 1px solid var(--ef-line); border-radius: 6px;
        background: color-mix(in srgb, var(--ef-panel) 95%, transparent);
        font-size: 0.78rem; color: var(--ef-ink);
        font-variant-numeric: tabular-nums; flex-wrap: wrap;
      }
      .row[data-tone='warn'] {
        background: color-mix(in srgb, var(--ef-warn) 8%, var(--ef-panel));
        border-color: color-mix(in srgb, var(--ef-warn) 35%, var(--ef-line));
      }
      .row[data-tone='bad'] {
        background: color-mix(in srgb, var(--ef-bad) 10%, var(--ef-panel));
        border-color: color-mix(in srgb, var(--ef-bad) 40%, var(--ef-line));
      }
      .row .label { font-weight: 600; flex: 0 0 auto; min-width: 110px; }
      .row .meta { color: var(--ef-muted); flex: 1 1 auto; font-size: 0.72rem; }
      .row .num { font-family: ui-monospace, monospace; }
      .row .num.warn { color: var(--ef-warn); font-weight: 600; }
      .row .num.bad { color: var(--ef-bad); font-weight: 600; }
      .row .right { margin-left: auto; color: var(--ef-muted); font-size: 0.7rem; }
      /* Incident row: severity tag + alert count chip. */
      .incident {
        display: grid; grid-template-columns: 1fr auto; gap: 4px 8px; padding: 6px 8px;
        border: 1px solid var(--ef-line); border-radius: 6px;
        background: color-mix(in srgb, var(--ef-panel) 92%, transparent); font-size: 0.78rem;
      }
      .incident .title-line { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; }
      .incident .name { font-weight: 600; color: var(--ef-ink); }
      .incident .scope {
        font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--ef-muted);
      }
      .incident .detail {
        font-size: 0.72rem; color: var(--ef-muted); line-height: 1.35; grid-column: 1 / -1;
      }
      /* NWS alert — warn-toned to match storm semantics. */
      .nws-row {
        padding: 6px 8px; border-radius: 6px; font-size: 0.78rem;
        border: 1px solid color-mix(in srgb, var(--ef-warn) 45%, var(--ef-line));
        background: color-mix(in srgb, var(--ef-warn) 6%, var(--ef-panel));
      }
      .nws-row .event { font-weight: 600; color: var(--ef-ink); }
      .nws-row .headline { font-size: 0.72rem; color: var(--ef-muted); margin-top: 2px; line-height: 1.35; }
      .nws-row .sev { font-size: 0.65rem; color: var(--ef-muted); margin-top: 2px; }
      /* Tiny hour-strip used by soiling-per-hour and shade. */
      .hour-strip {
        display: grid; grid-template-columns: repeat(auto-fit, minmax(40px, 1fr));
        gap: 4px; width: 100%;
      }
      .hour-cell {
        text-align: center; padding: 4px 2px; border-radius: 4px;
        border: 1px solid var(--ef-line); font-size: 0.65rem;
        font-family: ui-monospace, monospace;
        background: color-mix(in srgb, var(--ef-panel) 95%, transparent);
      }
      .hour-cell .h { color: var(--ef-muted); font-size: 0.6rem; }
      .hour-cell.warn {
        color: var(--ef-warn);
        border-color: color-mix(in srgb, var(--ef-warn) 35%, var(--ef-line));
      }
      .no-data { font-size: 0.78rem; color: var(--ef-muted); padding: 6px 0; }
      /* Toggle button for expand/collapse, mirrors alerts-card .show-btn. */
      button.toggle {
        font: inherit; font-size: 0.75rem; background: transparent;
        border: 1px solid var(--ef-line); border-radius: 6px; padding: 2px 8px;
        color: var(--ef-accent); cursor: pointer;
      }
      button.toggle:hover { background: color-mix(in srgb, var(--ef-accent) 8%, transparent); }
      /* Sub-block header inside dense sections (Equipment / Soiling). */
      .sub-head {
        font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.06em;
        color: var(--ef-muted); margin: 4px 0 2px;
      }
      .ev-summary { font-size: 0.72rem; color: var(--ef-muted); margin-bottom: 4px; }
      .checkpoint-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 3px; margin-top: 4px; }
      .checkpoint {
        text-align: center; padding: 2px 4px; border-radius: 4px;
        background: color-mix(in srgb, var(--ef-panel) 90%, transparent);
        font-family: ui-monospace, monospace; font-size: 0.65rem;
      }
      .checkpoint .soc { color: var(--ef-muted); font-size: 0.6rem; }
    `],t([ue()],e.EcoflowInsightsCard.prototype,"sc",void 0),t([ue()],e.EcoflowInsightsCard.prototype,"thermal",void 0),t([ue()],e.EcoflowInsightsCard.prototype,"equip",void 0),t([ue()],e.EcoflowInsightsCard.prototype,"shade",void 0),t([ue()],e.EcoflowInsightsCard.prototype,"soil",void 0),t([ue()],e.EcoflowInsightsCard.prototype,"mismatch",void 0),t([ue()],e.EcoflowInsightsCard.prototype,"ev",void 0),t([ue()],e.EcoflowInsightsCard.prototype,"charge",void 0),t([ue()],e.EcoflowInsightsCard.prototype,"ir",void 0),t([ue()],e.EcoflowInsightsCard.prototype,"skill",void 0),t([ue()],e.EcoflowInsightsCard.prototype,"ambient",void 0),t([ue()],e.EcoflowInsightsCard.prototype,"conf",void 0),t([ue()],e.EcoflowInsightsCard.prototype,"nws",void 0),t([ue()],e.EcoflowInsightsCard.prototype,"incidents",void 0),t([ue()],e.EcoflowInsightsCard.prototype,"ensemble",void 0),t([ue()],e.EcoflowInsightsCard.prototype,"expanded",void 0),e.EcoflowInsightsCard=t([(e=>(t,s)=>{void 0!==s?s.addInitializer(()=>{customElements.define(e,t)}):customElements.define(e,t)})("ecoflow-insights-card")],e.EcoflowInsightsCard);const Ce=window;return Ce.customCards=Ce.customCards||[],Ce.customCards.some(e=>"ecoflow-insights-card"===e.type)||Ce.customCards.push({type:"ecoflow-insights-card",name:"EcoFlow Advanced Insights",description:"v0.7.5 advanced analytics — incidents, NWS, self-consumption, equipment, etc."}),e}({});
//# sourceMappingURL=ecoflow-insights-card.js.map
