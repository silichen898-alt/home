// 全局变量
let currentProductId = null;
let currentOrder = null;

// 购买商品
function buyProduct(productId) {
    currentProductId = productId;
    
    // 获取商品详情
    fetch(`/api/product/${productId}`)
        .then(response => response.json())
        .then(product => {
            if (product.error) {
                alert('商品获取失败: ' + product.error);
                return;
            }
            
            // 显示商品信息
            document.getElementById('productInfo').innerHTML = `
                <div class="product-summary">
                    <h4>${product.email}</h4>
                    <div class="product-meta">
                        <span class="type-badge">${product.account_type}</span>
                        <span class="price-badge">$${product.price}</span>
                    </div>
                    <div class="product-features">
                        <div class="feature">
                            <i class="fas fa-envelope"></i>
                            <span>辅助邮箱: ${product.auxiliary_email || 'N/A'}</span>
                        </div>
                        <div class="feature">
                            <i class="fas fa-key"></i>
                            <span>2FA: ${product.two_fa_code ? '已配置' : '未配置'}</span>
                        </div>
                        <div class="feature">
                            <i class="fas fa-code"></i>
                            <span>API Key: ${product.account_key ? '已配置' : '未配置'}</span>
                        </div>
                    </div>
                </div>
            `;
            
            // 显示购买模态框
            document.getElementById('buyModal').style.display = 'block';
        })
        .catch(error => {
            console.error('获取商品详情失败:', error);
            alert('获取商品详情失败');
        });
}

// 关闭购买模态框
function closeBuyModal() {
    document.getElementById('buyModal').style.display = 'none';
    currentProductId = null;
}

// 关闭支付模态框
function closePaymentModal() {
    document.getElementById('paymentModal').style.display = 'none';
    currentOrder = null;
}

// 关闭成功模态框
function closeSuccessModal() {
    document.getElementById('successModal').style.display = 'none';
    // 刷新页面显示最新库存
    window.location.reload();
}

// 提交订单
document.getElementById('orderForm').addEventListener('submit', function(e) {
    e.preventDefault();
    
    const formData = new FormData(this);
    const orderData = {
        productId: currentProductId,
        buyerContact: formData.get('buyerContact'),
        paymentMethod: formData.get('paymentMethod'),
        usdtNetwork: formData.get('usdtNetwork') || 'trc20'
    };
    
    // 验证必填字段
    if (!orderData.buyerContact) {
        alert('请填写联系方式');
        return;
    }
    
    // 创建订单
    fetch('/api/order', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(orderData)
    })
    .then(response => response.json())
    .then(result => {
        if (result.success) {
            currentOrder = result.order;
            
            // 显示支付详情
            document.getElementById('paymentDetails').innerHTML = result.paymentDetails;
            
            // 设置确认支付按钮事件
            document.getElementById('confirmPaymentBtn').onclick = function() {
                confirmPayment(currentOrder.order_no);
            };
            
            // 关闭购买模态框，显示支付模态框
            closeBuyModal();
            document.getElementById('paymentModal').style.display = 'block';
        } else {
            alert('创建订单失败: ' + result.error);
        }
    })
    .catch(error => {
        console.error('创建订单失败:', error);
        alert('创建订单失败');
    });
});

// 确认支付
function confirmPayment(orderNo) {
    fetch('/api/payment/confirm', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ orderNo: orderNo })
    })
    .then(response => response.json())
    .then(result => {
        if (result.success) {
            // 显示账号信息
            document.getElementById('accountInfo').innerHTML = `
                <div class="account-details">
                    <h5>您的账号信息：</h5>
                    <div class="account-field">
                        <label>邮箱地址:</label>
                        <span class="value">${result.accountInfo.email}</span>
                        <button onclick="copyToClipboard('${result.accountInfo.email}')" class="copy-btn">
                            <i class="fas fa-copy"></i>
                        </button>
                    </div>
                    <div class="account-field">
                        <label>邮箱密码:</label>
                        <span class="value">${result.accountInfo.password}</span>
                        <button onclick="copyToClipboard('${result.accountInfo.password}')" class="copy-btn">
                            <i class="fas fa-copy"></i>
                        </button>
                    </div>
                    ${result.accountInfo.auxiliaryEmail ? `
                    <div class="account-field">
                        <label>辅助邮箱:</label>
                        <span class="value">${result.accountInfo.auxiliaryEmail}</span>
                        <button onclick="copyToClipboard('${result.accountInfo.auxiliaryEmail}')" class="copy-btn">
                            <i class="fas fa-copy"></i>
                        </button>
                    </div>` : ''}
                    ${result.accountInfo.twoFACode ? `
                    <div class="account-field">
                        <label>2FA密码:</label>
                        <span class="value">${result.accountInfo.twoFACode}</span>
                        <button onclick="copyToClipboard('${result.accountInfo.twoFACode}')" class="copy-btn">
                            <i class="fas fa-copy"></i>
                        </button>
                    </div>` : ''}
                    ${result.accountInfo.accountKey ? `
                    <div class="account-field">
                        <label>API密钥:</label>
                        <span class="value">${result.accountInfo.accountKey}</span>
                        <button onclick="copyToClipboard('${result.accountInfo.accountKey}')" class="copy-btn">
                            <i class="fas fa-copy"></i>
                        </button>
                    </div>` : ''}
                    <div class="success-note">
                        <p><i class="fas fa-info-circle"></i> 请妥善保存以上信息，关闭后将无法再次查看完整密码</p>
                    </div>
                </div>
            `;
            
            // 关闭支付模态框，显示成功模态框
            closePaymentModal();
            document.getElementById('successModal').style.display = 'block';
        } else {
            alert('支付确认失败: ' + result.error);
        }
    })
    .catch(error => {
        console.error('支付确认失败:', error);
        alert('支付确认失败');
    });
}

// 复制到剪贴板
function copyToClipboard(text) {
    navigator.clipboard.writeText(text).then(function() {
        // 显示复制成功提示
        showToast('已复制到剪贴板');
    }, function(err) {
        console.error('复制失败:', err);
        // 降级方案
        const textArea = document.createElement('textarea');
        textArea.value = text;
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
        showToast('已复制到剪贴板');
    });
}

// 显示提示消息
function showToast(message) {
    // 创建toast元素
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerHTML = `
        <i class="fas fa-check-circle"></i>
        <span>${message}</span>
    `;
    
    document.body.appendChild(toast);
    
    // 显示动画
    setTimeout(() => {
        toast.classList.add('show');
    }, 100);
    
    // 3秒后移除
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => {
            document.body.removeChild(toast);
        }, 300);
    }, 3000);
}

// 点击模态框外部关闭
window.onclick = function(event) {
    const buyModal = document.getElementById('buyModal');
    const paymentModal = document.getElementById('paymentModal');
    const successModal = document.getElementById('successModal');
    
    if (event.target === buyModal) {
        closeBuyModal();
    } else if (event.target === paymentModal) {
        closePaymentModal();
    } else if (event.target === successModal) {
        closeSuccessModal();
    }
}

// 页面加载完成
document.addEventListener('DOMContentLoaded', function() {
    console.log('Gmail商城前端已加载');
});