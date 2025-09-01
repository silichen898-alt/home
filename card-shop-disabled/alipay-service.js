const AlipaySdk = require('alipay-sdk').default;
const fs = require('fs');
const path = require('path');

class AlipayService {
    constructor() {
        // 支付宝配置
        this.config = {
            appId: process.env.ALIPAY_APP_ID || '2021000000000000', // 应用ID
            privateKey: process.env.ALIPAY_PRIVATE_KEY || '', // 应用私钥
            alipayPublicKey: process.env.ALIPAY_PUBLIC_KEY || '', // 支付宝公钥
            gateway: 'https://openapi.alipay.com/gateway.do', // 网关地址
            timeout: 5000,
            camelCase: true,
        };
        
        // 初始化SDK
        if (this.config.privateKey && this.config.alipayPublicKey) {
            this.alipaySdk = new AlipaySdk(this.config);
            this.isConfigured = true;
        } else {
            console.warn('⚠️ 支付宝API配置不完整，将使用模拟模式');
            this.isConfigured = false;
        }
    }
    
    // 创建支付二维码
    async createPaymentQR(orderData) {
        try {
            if (!this.isConfigured) {
                return this.createMockPaymentQR(orderData);
            }
            
            const result = await this.alipaySdk.exec('alipay.trade.precreate', {
                bizContent: {
                    out_trade_no: orderData.order_no, // 商户订单号
                    total_amount: orderData.total_amount, // 订单总金额
                    subject: `Gmail账号购买 - ${orderData.product.account_type}`, // 订单标题
                    body: `邮箱: ${orderData.product.email}`, // 订单描述
                    timeout_express: '30m', // 30分钟超时
                    notify_url: `${process.env.BASE_URL || 'http://localhost:3000'}/api/alipay/notify`, // 异步通知地址
                }
            });
            
            if (result.code === '10000') {
                return {
                    success: true,
                    qr_code: result.qrCode,
                    order_no: orderData.order_no,
                    amount: orderData.total_amount,
                    expires_at: new Date(Date.now() + 30 * 60 * 1000) // 30分钟后过期
                };
            } else {
                console.error('支付宝二维码创建失败:', result);
                return {
                    success: false,
                    error: result.msg || '创建支付二维码失败'
                };
            }
        } catch (error) {
            console.error('支付宝API调用失败:', error);
            return {
                success: false,
                error: '支付服务暂时不可用'
            };
        }
    }
    
    // 查询支付状态
    async queryPaymentStatus(orderNo) {
        try {
            if (!this.isConfigured) {
                return this.mockPaymentQuery(orderNo);
            }
            
            const result = await this.alipaySdk.exec('alipay.trade.query', {
                bizContent: {
                    out_trade_no: orderNo
                }
            });
            
            if (result.code === '10000') {
                return {
                    success: true,
                    trade_status: result.tradeStatus,
                    total_amount: result.totalAmount,
                    buyer_user_id: result.buyerUserId,
                    trade_no: result.tradeNo,
                    paid: result.tradeStatus === 'TRADE_SUCCESS'
                };
            } else {
                return {
                    success: false,
                    error: result.msg || '查询支付状态失败'
                };
            }
        } catch (error) {
            console.error('查询支付状态失败:', error);
            return {
                success: false,
                error: '查询支付状态失败'
            };
        }
    }
    
    // 验证支付宝异步通知
    validateNotify(postData) {
        try {
            if (!this.isConfigured) {
                return this.mockNotifyValidation(postData);
            }
            
            return this.alipaySdk.checkNotifySign(postData);
        } catch (error) {
            console.error('验证支付宝通知签名失败:', error);
            return false;
        }
    }
    
    // 处理支付宝异步通知
    async handleNotify(postData) {
        try {
            // 验证签名
            if (!this.validateNotify(postData)) {
                return {
                    success: false,
                    error: '签名验证失败'
                };
            }
            
            const {
                out_trade_no: orderNo,
                trade_status: tradeStatus,
                total_amount: totalAmount,
                trade_no: tradeNo,
                buyer_user_id: buyerUserId
            } = postData;
            
            // 检查交易状态
            if (tradeStatus === 'TRADE_SUCCESS') {
                return {
                    success: true,
                    paid: true,
                    order_no: orderNo,
                    trade_no: tradeNo,
                    amount: parseFloat(totalAmount),
                    buyer_id: buyerUserId,
                    message: '支付成功'
                };
            } else {
                return {
                    success: true,
                    paid: false,
                    order_no: orderNo,
                    trade_status: tradeStatus,
                    message: '支付状态: ' + tradeStatus
                };
            }
        } catch (error) {
            console.error('处理支付宝通知失败:', error);
            return {
                success: false,
                error: '处理通知失败'
            };
        }
    }
    
    // 模拟模式 - 创建支付二维码
    createMockPaymentQR(orderData) {
        console.log('🔧 模拟模式: 创建支付二维码');
        return {
            success: true,
            qr_code: `mock_qr_code_${orderData.order_no}`,
            order_no: orderData.order_no,
            amount: orderData.total_amount,
            expires_at: new Date(Date.now() + 30 * 60 * 1000),
            mock: true
        };
    }
    
    // 模拟模式 - 查询支付状态
    mockPaymentQuery(orderNo) {
        console.log('🔧 模拟模式: 查询支付状态', orderNo);
        
        // 模拟: 订单创建1分钟后自动标记为已支付
        const mockPaymentTime = 60 * 1000; // 1分钟
        const orderTime = parseInt(orderNo.replace('ORD', ''));
        const isPaid = (Date.now() - orderTime) > mockPaymentTime;
        
        return {
            success: true,
            trade_status: isPaid ? 'TRADE_SUCCESS' : 'WAIT_BUYER_PAY',
            total_amount: '0.01',
            trade_no: `mock_trade_${orderNo}`,
            paid: isPaid,
            mock: true
        };
    }
    
    // 模拟模式 - 验证通知
    mockNotifyValidation(postData) {
        console.log('🔧 模拟模式: 验证通知签名');
        return true; // 模拟模式总是返回true
    }
    
    // 检查配置状态
    isEnabled() {
        return this.isConfigured;
    }
    
    // 获取配置信息
    getConfig() {
        return {
            isConfigured: this.isConfigured,
            appId: this.config.appId,
            hasPrivateKey: !!this.config.privateKey,
            hasPublicKey: !!this.config.alipayPublicKey,
            gateway: this.config.gateway
        };
    }
}

module.exports = new AlipayService();