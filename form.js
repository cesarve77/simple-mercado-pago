import {Template} from 'meteor/templating'
import  {creditCardSchema}  from './credit-card-schema'
import {beginSubmit} from './utilities'
import {endSubmit} from './utilities'
import {ProgressModal} from './utilities'
import Card  from 'card'
import './form.html'
import {paymentSchema} from './payment-schema'
import {ReactiveVar} from 'meteor/reactive-var'
import {errorMessage} from './errors'
import {check} from 'meteor/check'
import {MP} from './client'
import {log} from './MP'

processing = new ProgressModal()

const showError503 = (error)=> {
    log('showError503', error)
    if (processing.isShow == false)
        processing.showPleaseWait()
    processing.setTitle('ERROR:')
    processing.setBody(error.reason || error.message)
    processing.setFooter('<button type="button" class="btn btn-default" data-dismiss="modal">Cerrar</button>')
}
const showOtherError = (error)=> {
    log('showOtherError', error)
    setTimeout(()=> {
        const msg = errorMessage(error)
        processing.setTitle('ERROR: No pudimos procesar con éxito su tarjeta!')
        processing.setBody('<b>Este es el error que nos regreso el banco:</b><br><br>' + msg)
        processing.setFooter('<button type="button" class="btn btn-default" data-dismiss="modal">Cerrar</button>')
    }, 600)
}
AutoForm.hooks({
    creditCard: {
        onSubmit: function (doc) {
            log('onSubmit', doc)
            event.preventDefault()
            //obtengo la data que viene del la declaración del template {{>MP_form data}} como this
            const payment = this.template.view.parentView.parentView.templateInstance().data
            //abro un modal con la barra de progreso
            processing.showPleaseWait()
            //meto el formulario completo en la variable form
            let form = $(this.event.currentTarget)
            //var validationContext = this.validationContext
            let paymentMethodId
            //encuentro el metodo de pago (visa master etc)
            Mercadopago.getPaymentMethod({
                "bin": doc.cardNumber.replace(/[ .-]/g, '').slice(0, 6)
            }, (status, response)=> {
                log('getPaymentMethod', status, response)
                //aumento la barra de progreso
                processing.setVal(15)
                //si el status es 2xx  bien si no hubo un error
                if (status < 200 || status > 208) {
                    //log('error getPaymentMethod')
                    const error = new Meteor.Error(503, 'No se pudo conectar con los servidores del banco, favor intente más tarde')

                    throw error
                } else {
                    //agrego el  paymentMethodId recibido al formulario que voya enviar
                    paymentMethodId = response[0].id
                    form.find('[name="paymentMethodId"]').val(paymentMethodId)
                }
                Mercadopago.createToken(form, (status, response)=> {
                    log('createToken', status, response)
                    //aumento la barra de progreso
                    processing.setVal(30)
                    //si el status es 2xx  bien si no hubo un error
                    if (status < 200 || status > 208) {
                        this.done(new Meteor.Error(status, response.message, response.cause))

                    } else {
                        //envio todos los datos mas los datos nuevos obtenidos (token y paymentMethodId)
                        payment.token = response.id
                        payment.payment_method_id = paymentMethodId
                        Meteor.call('mpCheckout', payment, (err, result)=> {
                            //aumento la barra de progreso a completado
                            processing.setVal(100)
                            if (err) {
                                //si hubo un error lo maneja onError de este mismo hook
                                this.done(err)
                            }
                            //si t o d o  esta bien  maneja onSuccess de este mismo hook
                            this.done(null, result)
                        })
                    }
                }); // The function "sdkResponseHandler"
            })
        },
        onSuccess: function (formType, result) {
            log('onSuccess', formType, result)
            //ocualto el modal de barra de progreso
            processing.hidePleaseWait()
            //ejecuto la funcion del usuario de la configuración MP.configure(successCallback:(result)=>{}) que recibe result
            MP.options.onSuccess(result)
        },
        onError: function (formType, error) {
            const payment = this.template.view.parentView.parentView.templateInstance().data
            log('onError', payment,formType, error)
            processing.end()
            switch (error.error) {
                //el error 503 o es leyendo la libreria o leyendo los tipos de
                case 503:
                    MP.options.onError(payment,error)
                    showError503(error)
                    break
                //402 es cuendo la tarjeta es rechazada
                case 402:
                    MP.options.onRejected(payment,error)
                    showOtherError(error)
                    break
                //otros errores
                default:
                    MP.options.onError(payment,error)
                    showOtherError(error)

            }
        },
        beginSubmit: function () {
            log('beginSubmit')
            beginSubmit('form', '.payment')
        },
        endSubmit: function () {
            log('log')
            Mercadopago.clearSession()
            endSubmit('form', '.payment')
        }
    }
})
Template.MP_form.onCreated(function () {
    log('onCreated',this)
    check(this, paymentSchema)
    this.libraryLoaded = new ReactiveVar(false)
    const library = document.createElement('script')
    //leemos dinamicamente la libreria de mecadolibre, esto es requicito de mercado libre
    library.src = "https://secure.mlstatic.com/sdk/javascript/v1/mercadopago.js"
    library.type = "text/javascript"
    const timeoutId = setTimeout(()=> {
        log('onload MP library Error')
        //si a los 10 segundos no la hemos podido leer es por que hay un error de conexcion
        const error = new Meteor.Error(503, 'No nos pudimos conectar con el banco.<br><br>Seguro es un problema temporal, por favor intenta más tarde')
        MP.options.onError(this.data,error)

        showError503(error)
        throw error
    }, 10000)
    library.onload = ()=> {
        log('onload MP library success')
        clearTimeout(timeoutId)
        this.libraryLoaded.set(true)
    }
    document.body.appendChild(library)
    //tipos de documentos vacio en principio
    this.indenificationsTypes = new ReactiveVar([{label: 'Cargando...', value: ''}])
    this.autorun(()=> {
        //Al ser leida la libreria
        if (this.libraryLoaded.get()) {

            let publicKey = Meteor.settings.public && Meteor.settings.public.MP && Meteor.settings.public.MP.publicKey
            //si no esta configurada en settings arrojo un error
            if (!publicKey)
                throw new Meteor.Error('404', 'No se encontro el MP.accessToken en Meteor.settings')
            //seteo la clave publica de mercado libre
            Mercadopago.setPublishableKey(publicKey)
            //leo de los servidores de mercadopago los tipos de
            Mercadopago.getIdentificationTypes((status, identificationsTypes)=> {
                log('getIdentificationTypes', status, identificationsTypes)
                console.log('identificationsTypes', status, identificationsTypes)
                if (status != 200 && status != 201) {
                    //todo
                    const error = new Meteor.Error(503, 'No nos pudimos conectar con el banco.<br><br>Seguro es un problema temporal, por favor intenta más tarde')
                    MP.options.onError(this.data,error)
                    showError503(error)
                    throw error
                }
                this.indenificationsTypes.set(
                    _.map(identificationsTypes, (indentificatonType)=> {
                        return {label: indentificatonType.name, value: indentificatonType.id}
                    })
                )
            })
        }
    })
})


Template.MP_form.helpers({
    //tipos de documents de identificación
    indenificationsTypes () {
        return Template.instance().indenificationsTypes.get()
    },
    creditCardSchema () {
        return creditCardSchema;
    },
    cardHolderName: function () {
        const cardHolderName = (this.payer.first_name != undefined ? this.payer.first_name : '' ) + ' ' + (this.payer.last_name != undefined ? this.payer.last_name : '')
        return cardHolderName.trim()
    },
    emailType: function () {
        console.log('this', this)
        if (this.payer.email)
            return 'hidden'
        else
            return 'email'
    }
})

Template.MP_form.onRendered(function () {
    log('onRendered')
    //bloqueo el formulario mientras no este cargada la libreria
    beginSubmit('form', '.payment')
    this.autorun(()=> {
        if (this.libraryLoaded.get()) {
            //desbloqueamos el formulario cuando se lea la libreria
            endSubmit('form', '.payment')
        }
    })
    //set installments to 1 if no exist, esta función limpia los datos segun el schema
    paymentSchema.clean(this.data)
    //creamos la tarjeta visual


})

