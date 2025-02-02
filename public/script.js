
document.addEventListener('DOMContentLoaded', () => {
    // Fetch and display events from TicketSource API
    const fetchEvents = async (eventRef, containerId) => {
        try {
            const response = await fetch(`https://api.ticketsource.io/v1/events?reference=${eventRef}`, {
                headers: {
                    "Authorization": "Bearer skl-J9fLpV5K6RoPnQbCFALr16aANibrWRf4OhxwxENOUu2NFWNtEJdvm8FLNgpa",
                    "Content-Type": "application/json"
                }
            });
            const data = await response.json();
            const container = document.getElementById(containerId);
            container.innerHTML = data.events.map(event => `
                <div class="event">
                    <h3>${event.name}</h3>
                    <p>${event.description}</p>
                    <a href="${event.ticket_url}" target="_blank">Book Tickets</a>
                </div>
            `).join('');
        } catch (error) {
            console.error('Error fetching events:', error);
        }
    };

    // Initialize API data for each section
    fetchEvents('General', 'general-events');
    fetchEvents('Summer', 'summer-events');
    fetchEvents('Halloween', 'halloween-events');
});
