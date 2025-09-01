// 管理后台JavaScript

// 刷新数据
function refreshData() {
    window.location.reload();
}

// 查看商品详情
function viewProduct(productId) {
    fetch(`/api/product/${productId}`)
        .then(response => response.json())
        .then(product => {
            if (product.error) {
                alert('获取商品详情失败: ' + product.error);
                return;
            }
            
            document.getElementById('productDetails').innerHTML = `
                <div class="product-detail-view">
                    <h4>商品详细信息</h4>
                    <div class="detail-grid">
                        <div class="detail-row">
                            <label>商品ID:</label>
                            <span>${product.id}</span>
                        </div>
                        <div class="detail-row">
                            <label>邮箱地址:</label>
                            <span>${product.email}</span>
                            <button onclick="copyToClipboard('${product.email}')" class="copy-btn">
                                <i class="fas fa-copy"></i>
                            </button>
                        </div>
                        <div class="detail-row">
                            <label>邮箱密码:</label>
                            <span class="password-field">${product.password}</span>
                            <button onclick="copyToClipboard('${product.password}')" class="copy-btn">
                                <i class="fas fa-copy"></i>
                            </button>
                        </div>
                        <div class="detail-row">
                            <label>账号类型:</label>
                            <span class="type-badge type-${product.account_type.toLowerCase()}">${product.account_type}</span>
                        </div>
                        <div class="detail-row">
                            <label>销售价格:</label>
                            <span class="price">$${product.price}</span>
                        </div>
                        <div class="detail-row">
                            <label>辅助邮箱:</label>
                            <span>${product.auxiliary_email || 'N/A'}</span>
                            ${product.auxiliary_email ? `<button onclick="copyToClipboard('${product.auxiliary_email}')" class="copy-btn"><i class="fas fa-copy"></i></button>` : ''}
                        </div>
                        <div class="detail-row">
                            <label>2FA密码:</label>
                            <span>${product.two_fa_code || 'N/A'}</span>
                            ${product.two_fa_code ? `<button onclick="copyToClipboard('${product.two_fa_code}')" class="copy-btn"><i class="fas fa-copy"></i></button>` : ''}
                        </div>
                        <div class="detail-row">
                            <label>API密钥:</label>
                            <span class="api-key-full">${product.account_key || 'N/A'}</span>
                            ${product.account_key ? `<button onclick="copyToClipboard('${product.account_key}')" class="copy-btn"><i class="fas fa-copy"></i></button>` : ''}
                        </div>
                        <div class="detail-row">
                            <label>商品状态:</label>
                            <span class="status-badge status-${product.status}">
                                ${product.status === 'available' ? '可售' : '已售'}
                            </span>
                        </div>
                        <div class="detail-row">
                            <label>创建时间:</label>
                            <span>${new Date(product.created_at).toLocaleString('zh-CN')}</span>
                        </div>
                        <div class="detail-row">
                            <label>更新时间:</label>
                            <span>${new Date(product.updated_at).toLocaleString('zh-CN')}</span>
                        </div>
                    </div>
                </div>
            `;
            
            document.getElementById('productModal').style.display = 'block';
        })
        .catch(error => {
            console.error('获取商品详情失败:', error);
            alert('获取商品详情失败');
        });
}

// 关闭商品详情模态框
function closeProductModal() {
    document.getElementById('productModal').style.display = 'none';
}

// 恢复已售商品
function restoreProduct(productId) {
    if (!confirm('确定要将此商品恢复为可售状态吗？')) {
        return;
    }
    
    fetch(`/api/product/${productId}/restore`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        }
    })
    .then(response => response.json())
    .then(result => {
        if (result.success) {
            showToast('商品已恢复为可售状态');
            setTimeout(() => {
                window.location.reload();
            }, 1500);
        } else {
            alert('恢复失败: ' + result.error);
        }
    })
    .catch(error => {
        console.error('恢复商品失败:', error);
        alert('恢复商品失败');
    });
}

// 确认支付（管理员操作）
function confirmPayment(orderNo) {
    if (!confirm('确定要确认此订单的支付状态吗？')) {
        return;
    }
    
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
            showToast('支付确认成功，商品已发货');
            setTimeout(() => {
                window.location.reload();
            }, 1500);
        } else {
            alert('确认支付失败: ' + result.error);
        }
    })
    .catch(error => {
        console.error('确认支付失败:', error);
        alert('确认支付失败');
    });
}

// 复制到剪贴板
function copyToClipboard(text) {
    navigator.clipboard.writeText(text).then(function() {
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
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerHTML = `
        <i class="fas fa-check-circle"></i>
        <span>${message}</span>
    `;
    
    document.body.appendChild(toast);
    
    setTimeout(() => {
        toast.classList.add('show');
    }, 100);
    
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => {
            document.body.removeChild(toast);
        }, 300);
    }, 3000);
}

// 页面加载完成
document.addEventListener('DOMContentLoaded', function() {
    console.log('管理后台已加载');
    
    // 自动刷新统计数据（每30秒）
    setInterval(function() {
        fetch('/api/stats')
            .then(response => response.json())
            .then(stats => {
                console.log('统计数据已更新:', stats);
            })
            .catch(error => {
                console.error('获取统计数据失败:', error);
            });
    }, 30000);
});